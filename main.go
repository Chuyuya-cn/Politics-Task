package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"politicsqa/internal/server"
)

// The web UI and the default content are embedded so the released executable
// can be copied to another machine without a build step. Editable copies of
// backgrounds/ and prompts/ still live next to the executable and always take
// precedence over these embedded defaults.
//
//go:embed web backgrounds prompts
var embedded embed.FS

func main() {
	var (
		port       int
		dataDir    string
		noOpen     bool
		showVer    bool
		upstream   string
		listenHost string
		lan        bool
		allowHosts string
	)

	flag.IntVar(&port, "port", 0, "local HTTP port (0 chooses a free port)")
	flag.StringVar(&dataDir, "data", "", "content directory (defaults to the executable directory)")
	flag.BoolVar(&noOpen, "no-open", false, "do not open a browser automatically")
	flag.BoolVar(&showVer, "version", false, "print version and exit")
	flag.StringVar(&upstream, "upstream", "", "override DeepSeek API base URL (development/testing only)")
	flag.StringVar(&listenHost, "host", "", "address to listen on (default 127.0.0.1; LAN mode uses 0.0.0.0)")
	flag.BoolVar(&lan, "lan", false, "allow phones on the same Wi-Fi to open the app")
	flag.StringVar(&allowHosts, "allow-host", "", "extra Host headers to accept, comma separated (tunnel domains)")
	flag.Parse()

	if showVer {
		fmt.Println(server.Version)
		return
	}

	webFS, err := fs.Sub(embedded, "web")
	if err != nil {
		log.Fatalf("embedded web assets: %v", err)
	}

	contentDir := dataDir
	if strings.TrimSpace(contentDir) == "" {
		contentDir = defaultContentDir()
	}
	absContentDir, err := filepath.Abs(contentDir)
	if err != nil {
		log.Fatalf("resolve content directory: %v", err)
	}
	if err := os.MkdirAll(absContentDir, 0o755); err != nil {
		log.Fatalf("create content directory: %v", err)
	}

	baseURL := strings.TrimSpace(upstream)
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("DEEPSEEK_BASE_URL"))
	}
	if baseURL == "" {
		baseURL = "https://api.deepseek.com"
	}

	extraHosts := splitHosts(allowHosts)
	if lan {
		for _, address := range server.HostPolicyFromOptions(true, nil).InterfaceIPs {
			extraHosts = append(extraHosts, address)
		}
	}
	hosts := server.HostPolicyFromOptions(lan, extraHosts)

	app, err := server.New(server.Options{
		WebFS:        webFS,
		SeedFS:       embedded,
		DataDir:      absContentDir,
		UpstreamBase: baseURL,
		Hosts:        hosts,
	})
	if err != nil {
		log.Fatalf("initialise application: %v", err)
	}

	bindHost := strings.TrimSpace(listenHost)
	if bindHost == "" {
		if lan {
			bindHost = "0.0.0.0"
		} else {
			bindHost = "127.0.0.1"
		}
	}
	addr := fmt.Sprintf("%s:%d", bindHost, port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", addr, err)
	}
	boundPort := listener.Addr().(*net.TCPAddr).Port

	url := fmt.Sprintf("http://127.0.0.1:%d", boundPort)
	fmt.Println("┌──────────────────────────────────────────────┐")
	fmt.Println("│  政问 · 政治课程问答                          │")
	fmt.Println("│  Politics Q&A — local browser application    │")
	fmt.Println("└──────────────────────────────────────────────┘")
	fmt.Printf("本机访问 / Local:  %s\n", url)
	fmt.Printf("内容目录 / Content: %s\n", absContentDir)

	if lan {
		addresses := hosts.LANAddresses(boundPort)
		if len(addresses) == 0 {
			fmt.Println("手机访问 / Phone: 未检测到局域网地址，请确认已连接 Wi-Fi。")
		} else {
			fmt.Println()
			fmt.Println("手机访问 / Phone — 与电脑连接同一 Wi-Fi，扫码或输入地址：")
			for _, address := range addresses {
				fmt.Printf("  %s\n", address)
			}
			if path, qrErr := hosts.WriteQRFile(absContentDir, boundPort); qrErr == nil {
				fmt.Printf("二维码图片 / QR image: %s\n", path)
			}
			if blocks := hosts.TerminalQRCodes(boundPort); len(blocks) > 0 {
				fmt.Println()
				for _, block := range blocks {
					fmt.Println(block)
				}
			}
			fmt.Println("提示：Windows 首次运行可能弹出防火墙提示，请选择“允许访问”。")
		}
	}
	fmt.Println("Keep this window open. Press Ctrl+C to stop.")
	fmt.Println()

	if !noOpen {
		go openBrowser(url)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Serve(listener)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = app.Shutdown(shutdownCtx)
		fmt.Println("Stopped.")
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}
}

func defaultContentDir() string {
	exe, err := os.Executable()
	if err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		// `go run` places the binary in a temporary go-build directory. In that
		// case the project working directory is the useful content location.
		lower := strings.ToLower(exe)
		if !strings.Contains(lower, "go-build") && !strings.Contains(lower, "\\temp\\go-build") {
			return filepath.Dir(exe)
		}
	}
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}

func openBrowser(url string) {
	time.Sleep(450 * time.Millisecond)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("could not open a browser automatically; open %s manually: %v", url, err)
	}
}

// splitHosts parses a comma-separated allowlist such as
// "abc.trycloudflare.com,myhost.local".
func splitHosts(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
