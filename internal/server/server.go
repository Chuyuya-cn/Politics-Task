package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Version is shown in the local health endpoint and the launcher banner.
const Version = "1.0.0"

// Options configures the local application.
type Options struct {
	WebFS        fs.FS
	SeedFS       fs.FS
	DataDir      string
	UpstreamBase string
	// Hosts decides which Host headers are accepted. The zero value keeps the
	// original loopback-only behaviour.
	Hosts HostPolicy
}

// App is the local web application. It serves the browser UI, exposes the
// replaceable content folders, and forwards a fixed set of DeepSeek endpoints.
type App struct {
	webFS           fs.FS
	dataDir         string
	backgroundsDir  string
	promptsDir      string
	upstreamBase    string
	hosts           HostPolicy
	client          *http.Client
	httpServer      *http.Server
	httpServerMutex sync.Mutex
}

// New creates an App, ensures the content folders exist, and seeds a fresh
// folder with the bundled defaults.
func New(opts Options) (*App, error) {
	if opts.WebFS == nil {
		return nil, fmt.Errorf("web filesystem is required")
	}
	if strings.TrimSpace(opts.DataDir) == "" {
		return nil, fmt.Errorf("data directory is required")
	}
	dataDir, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return nil, err
	}
	backgroundsDir := filepath.Join(dataDir, "backgrounds")
	promptsDir := filepath.Join(dataDir, "prompts")
	if err := os.MkdirAll(backgroundsDir, 0o755); err != nil {
		return nil, fmt.Errorf("create backgrounds directory: %w", err)
	}
	if err := os.MkdirAll(promptsDir, 0o755); err != nil {
		return nil, fmt.Errorf("create prompts directory: %w", err)
	}

	if opts.SeedFS != nil {
		if err := seedIfEmpty(opts.SeedFS, "backgrounds", backgroundsDir); err != nil {
			return nil, fmt.Errorf("seed backgrounds: %w", err)
		}
		if err := seedIfEmpty(opts.SeedFS, "prompts", promptsDir); err != nil {
			return nil, fmt.Errorf("seed prompts: %w", err)
		}
	}

	base := strings.TrimRight(strings.TrimSpace(opts.UpstreamBase), "/")
	if base == "" {
		base = "https://api.deepseek.com"
	}
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("invalid upstream base URL")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.ResponseHeaderTimeout = 120 * time.Second
	transport.MaxIdleConnsPerHost = 4

	return &App{
		webFS:          opts.WebFS,
		dataDir:        dataDir,
		backgroundsDir: backgroundsDir,
		promptsDir:     promptsDir,
		upstreamBase:   base,
		hosts:          opts.Hosts,
		client:         &http.Client{Transport: transport},
	}, nil
}

// Handler returns the complete HTTP handler. The handler is intentionally
// same-origin only: the browser never needs to make a cross-origin request.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/local-api/health", a.handleHealth)
	mux.HandleFunc("/local-api/content", a.handleContent)
	mux.HandleFunc("/local-api/validate", a.handleValidate)
	mux.HandleFunc("/local-api/search", a.handleSearch)
	mux.HandleFunc("/local-api/chat", a.handleChat)
	mux.HandleFunc("/backgrounds/", a.handleBackground)
	mux.HandleFunc("/prompts/", a.handlePrompt)
	mux.HandleFunc("/", a.handleWeb)
	return a.secure(mux)
}

// Serve starts the HTTP server on an already-bound listener.
func (a *App) Serve(listener net.Listener) error {
	a.httpServerMutex.Lock()
	a.httpServer = &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	server := a.httpServer
	a.httpServerMutex.Unlock()
	return server.Serve(listener)
}

// Shutdown gracefully stops the local HTTP server.
func (a *App) Shutdown(ctx context.Context) error {
	a.httpServerMutex.Lock()
	server := a.httpServer
	a.httpServerMutex.Unlock()
	if server == nil {
		return nil
	}
	return server.Shutdown(ctx)
}

func (a *App) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.hosts.Allow(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/local-api/") && !isAllowedOrigin(r) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}

		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; "+
				"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": Version,
	})
}

func (a *App) handleWeb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	if r.URL.Path != "/" && strings.HasSuffix(r.URL.Path, "/") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.FileServer(http.FS(a.webFS)).ServeHTTP(w, r)
}

type fileEntry struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type contentManifest struct {
	Backgrounds       []fileEntry `json:"backgrounds"`
	Prompts           []fileEntry `json:"prompts"`
	DefaultBackground string      `json:"defaultBackground"`
	DefaultPrompt     string      `json:"defaultPrompt"`
}

func (a *App) handleContent(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}

	backgroundNames, err := listFiles(a.backgroundsDir, backgroundExtensions)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "无法读取底图目录。")
		return
	}
	promptNames, err := listFiles(a.promptsDir, promptExtensions)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "无法读取提示词目录。")
		return
	}

	manifest := contentManifest{
		Backgrounds: make([]fileEntry, 0, len(backgroundNames)),
		Prompts:     make([]fileEntry, 0, len(promptNames)),
	}
	for _, name := range backgroundNames {
		manifest.Backgrounds = append(manifest.Backgrounds, fileEntry{
			Name: name,
			URL:  contentURL("backgrounds", name),
		})
	}
	for _, name := range promptNames {
		// README.txt is an instruction sheet, not a selectable prompting mode.
		if strings.HasPrefix(strings.ToUpper(name), "README") {
			continue
		}
		manifest.Prompts = append(manifest.Prompts, fileEntry{
			Name: name,
			URL:  contentURL("prompts", name),
		})
	}
	if len(backgroundNames) > 0 {
		manifest.DefaultBackground = backgroundNames[0]
		// A file explicitly named 00-* wins. Otherwise the bundled default.svg
		// remains the stable default even if other images are added.
		hasExplicitDefault := false
		for _, name := range backgroundNames {
			if strings.HasPrefix(name, "00-") {
				manifest.DefaultBackground = name
				hasExplicitDefault = true
				break
			}
		}
		if !hasExplicitDefault {
			for _, name := range backgroundNames {
				if strings.EqualFold(name, "default.svg") {
					manifest.DefaultBackground = name
					break
				}
			}
		}
	}
	if len(manifest.Prompts) > 0 {
		manifest.DefaultPrompt = manifest.Prompts[0].Name
		for _, entry := range manifest.Prompts {
			if strings.HasPrefix(entry.Name, "01-") {
				manifest.DefaultPrompt = entry.Name
				break
			}
		}
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, manifest)
}

func (a *App) handleBackground(w http.ResponseWriter, r *http.Request) {
	a.serveContentFile(w, r, a.backgroundsDir, backgroundExtensions)
}

func (a *App) handlePrompt(w http.ResponseWriter, r *http.Request) {
	a.serveContentFile(w, r, a.promptsDir, promptExtensions)
}

func (a *App) serveContentFile(w http.ResponseWriter, r *http.Request, dir string, allowed map[string]bool) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w, http.MethodGet, http.MethodHead)
		return
	}
	prefix := "/backgrounds/"
	if dir == a.promptsDir {
		prefix = "/prompts/"
	}
	name := strings.TrimPrefix(r.URL.Path, prefix)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		http.NotFound(w, r)
		return
	}
	if name != filepath.Base(name) {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(name))
	if !allowed[ext] {
		http.NotFound(w, r)
		return
	}

	fullPath := filepath.Join(dir, name)
	file, err := os.Open(fullPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	switch ext {
	case ".md":
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml")
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func contentURL(kind, name string) string {
	u := url.URL{Path: "/" + kind + "/" + name}
	return u.EscapedPath()
}

func (a *App) handleProxyError(w http.ResponseWriter, status int, message string) {
	writeJSONError(w, status, message)
}

func methodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeJSONError(w, http.StatusMethodNotAllowed, "请求方法不被允许。")
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "local_error",
		},
	})
}

func listFiles(dir string, allowed map[string]bool) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if allowed[strings.ToLower(filepath.Ext(name))] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names, nil
}

func isAllowedOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if origin == "null" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return false
	}
	return strings.EqualFold(parsed.Host, r.Host)
}
