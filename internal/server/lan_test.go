package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHostPolicyLoopbackOnlyByDefault(t *testing.T) {
	policy := HostPolicy{}
	cases := map[string]bool{
		"127.0.0.1:5199":      true,
		"localhost:5199":      true,
		"[::1]:5199":          true,
		"localhost":           true,
		"192.168.1.50:5199":   false,
		"10.9.121.137:5199":   false,
		"evil.example:5199":   false,
		"linzi-pc.local:5199": false,
	}
	for host, want := range cases {
		if got := policy.Allow(host); got != want {
			t.Errorf("Allow(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestHostPolicyLANAcceptsOwnInterfaces(t *testing.T) {
	policy := HostPolicy{
		LANEnabled:   true,
		InterfaceIPs: []string{"10.9.121.137", "192.168.1.50"},
	}
	cases := map[string]bool{
		"10.9.121.137:5199":   true,
		"192.168.1.50:5199":   true,
		"10.9.121.137":        true,
		"linzi-pc.local:5199": true,
		"10.0.0.99:5199":      false,
		"evil.example:5199":   false,
	}
	for host, want := range cases {
		if got := policy.Allow(host); got != want {
			t.Errorf("Allow(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestHostPolicyExtraHostsForTunnel(t *testing.T) {
	policy := HostPolicy{ExtraHosts: []string{"abc.trycloudflare.com", "MyHost.local"}}
	if !policy.Allow("abc.trycloudflare.com") {
		t.Error("extra tunnel host should be allowed")
	}
	if !policy.Allow("myhost.local:443") {
		t.Error("extra host matching should be case-insensitive")
	}
	if policy.Allow("other.trycloudflare.com") {
		t.Error("unlisted tunnel host should be rejected")
	}
}

func TestLANModeRejectsUnknownHostAtHTTPLevel(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	app.hosts = HostPolicy{LANEnabled: true, InterfaceIPs: []string{"10.9.121.137"}}
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	req, _ := http.NewRequest(http.MethodGet, server.URL+"/local-api/health", nil)
	req.Host = "10.9.121.137:5199"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("LAN host status = %d, want 200", resp.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodGet, server.URL+"/local-api/health", nil)
	req2.Host = "attacker.example:5199"
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Fatalf("unknown host status = %d, want 403", resp2.StatusCode)
	}
}

func TestLANAddressesAndQR(t *testing.T) {
	policy := HostPolicy{
		LANEnabled:   true,
		InterfaceIPs: []string{"10.9.121.137", "not-an-ip"},
	}
	addresses := policy.LANAddresses(5199)
	if len(addresses) != 1 || addresses[0] != "http://10.9.121.137:5199" {
		t.Fatalf("addresses = %v", addresses)
	}

	blocks := policy.TerminalQRCodes(5199)
	if len(blocks) != 1 {
		t.Fatalf("qr blocks = %d", len(blocks))
	}

	png, address, err := policy.QRPNG(5199, 256)
	if err != nil {
		t.Fatalf("QRPNG: %v", err)
	}
	if address != "http://10.9.121.137:5199" {
		t.Fatalf("qr address = %q", address)
	}
	if len(png) < 100 || png[0] != 0x89 || string(png[1:4]) != "PNG" {
		t.Fatalf("not a PNG: %d bytes", len(png))
	}
}

func TestLANModeWithoutInterfaceDoesNotPanic(t *testing.T) {
	policy := HostPolicy{LANEnabled: true}
	if len(policy.LANAddresses(5199)) != 0 {
		t.Fatal("expected no addresses")
	}
	if _, _, err := policy.QRPNG(5199, 256); err == nil {
		t.Fatal("expected an error when no LAN address exists")
	}
}
