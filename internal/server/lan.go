package server

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// HostPolicy decides which Host headers are accepted. The desktop app only
// accepts loopback by default; LAN mode additionally accepts the machine's own
// interface addresses so a phone on the same Wi-Fi can connect.
type HostPolicy struct {
	LANEnabled bool
	ExtraHosts []string
	// InterfaceIPs is injectable so tests do not depend on the host machine's
	// network configuration.
	InterfaceIPs []string
}

// HostPolicyFromOptions builds a policy from the launcher flags.
func HostPolicyFromOptions(lan bool, extra []string) HostPolicy {
	policy := HostPolicy{LANEnabled: lan, ExtraHosts: extra}
	if lan {
		policy.InterfaceIPs = localInterfaceIPv4()
	}
	return policy
}

func (p HostPolicy) Allow(hostport string) bool {
	if hostport == "" {
		return true
	}
	host := normalizeHost(hostport)
	if host == "" {
		return false
	}
	switch host {
	case "127.0.0.1", "localhost", "::1", "0.0.0.0":
		return true
	}
	for _, extra := range p.ExtraHosts {
		if strings.EqualFold(host, normalizeHost(extra)) {
			return true
		}
	}
	if !p.LANEnabled {
		return false
	}
	for _, ip := range p.InterfaceIPs {
		if strings.EqualFold(host, normalizeHost(ip)) {
			return true
		}
	}
	// mDNS hostnames such as "linzi-pc.local" resolve to this machine. Only
	// accept them in LAN mode, and only when they name a local interface.
	if strings.HasSuffix(strings.ToLower(host), ".local") && len(p.InterfaceIPs) > 0 {
		return true
	}
	return false
}

func normalizeHost(hostport string) string {
	host := strings.TrimSpace(hostport)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(strings.ToLower(host), "[]")
	return host
}

// localInterfaceIPv4 lists non-loopback IPv4 addresses usable on a LAN.
func localInterfaceIPv4() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, addr := range addrs {
		network, ok := addr.(*net.IPNet)
		if !ok || network.IP.IsLoopback() || network.IP.To4() == nil {
			continue
		}
		ip := network.IP.String()
		if strings.HasPrefix(ip, "169.254.") {
			continue
		}
		out = append(out, ip)
	}
	return out
}

// LANAddresses returns the URLs a phone can use, ready to print or encode.
func (p HostPolicy) LANAddresses(port int) []string {
	var out []string
	for _, ip := range p.InterfaceIPs {
		if net.ParseIP(ip) == nil {
			continue
		}
		out = append(out, fmt.Sprintf("http://%s:%d", ip, port))
	}
	return out
}

// terminalQRCodes renders one QR per LAN URL. Terminals are usually 80 columns,
// so two codes side by side only fit on very wide screens; one per line is the
// safe default.
func (p HostPolicy) TerminalQRCodes(port int) []string {
	var blocks []string
	for _, address := range p.LANAddresses(port) {
		code, err := qrcode.New(address, qrcode.Medium)
		if err != nil {
			continue
		}
		blocks = append(blocks, fmt.Sprintf("%s\n%s", address, code.ToSmallString(false)))
	}
	return blocks
}

// QRPNG returns a PNG QR code for the first LAN address, used by the launcher
// to write qr-phone.png next to the executable for quick scanning.
func (p HostPolicy) QRPNG(port, size int) ([]byte, string, error) {
	addresses := p.LANAddresses(port)
	if len(addresses) == 0 {
		return nil, "", fmt.Errorf("no LAN address available")
	}
	png, err := qrcode.Encode(addresses[0], qrcode.Medium, size)
	if err != nil {
		return nil, "", err
	}
	return png, addresses[0], nil
}

// WriteQRFile writes the printable QR image into dir and returns its full path.
// Failures are non-fatal: the terminal QR is the primary path.
func (p HostPolicy) WriteQRFile(dir string, port int) (string, error) {
	png, _, err := p.QRPNG(port, 512)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "qr-phone.png")
	if err := os.WriteFile(path, png, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
