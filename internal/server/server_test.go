package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func newTestApp(t *testing.T, upstream string) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	web := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html><title>test</title>")},
		"js/app.js":  {Data: []byte("console.log('ok')")},
	}
	seed := fstest.MapFS{
		"backgrounds/default.svg": {Data: []byte("<svg/>")},
		"prompts/01-course.md":    {Data: []byte("course prompt")},
		"prompts/README.txt":      {Data: []byte("instructions")},
	}
	app, err := New(Options{
		WebFS:        web,
		SeedFS:       seed,
		DataDir:      dir,
		UpstreamBase: upstream,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return app, dir
}

func TestHealthAndSecurityHeaders(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	resp, err := http.Get(server.URL + "/local-api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("missing nosniff header: %q", got)
	}
	if got := resp.Header.Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("missing frame header: %q", got)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("unexpected CSP: %q", csp)
	}
}

func TestManifestListsContentAndFiltersReadme(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	resp, err := http.Get(server.URL + "/local-api/content")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var manifest contentManifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Backgrounds) != 1 || manifest.Backgrounds[0].Name != "default.svg" {
		t.Fatalf("backgrounds = %+v", manifest.Backgrounds)
	}
	if len(manifest.Prompts) != 1 || manifest.Prompts[0].Name != "01-course.md" {
		t.Fatalf("prompts = %+v", manifest.Prompts)
	}
	if manifest.DefaultPrompt != "01-course.md" {
		t.Fatalf("defaultPrompt = %q", manifest.DefaultPrompt)
	}
}

func TestContentFileRejectsTraversal(t *testing.T) {
	app, dir := newTestApp(t, "https://api.deepseek.com")
	secret := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secret, []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	cases := []string{
		"/backgrounds/../secret.txt",
		"/backgrounds/%2e%2e%2fsecret.txt",
		"/backgrounds/..%2Fsecret.txt",
	}
	for _, path := range cases {
		resp, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s returned %d, want 404", path, resp.StatusCode)
		}
	}
}

func TestPromptSeededAndServed(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	resp, err := http.Get(server.URL + "/prompts/01-course.md")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "course prompt" {
		t.Fatalf("body = %q", body)
	}
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "text/markdown") {
		t.Fatalf("content type = %q", got)
	}
}

func TestSeedDoesNotOverwriteUserFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "backgrounds"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "backgrounds", "default.svg"), []byte("user-file"), 0o644); err != nil {
		t.Fatal(err)
	}
	seed := fstest.MapFS{"backgrounds/default.svg": {Data: []byte("bundled-file")}}
	if err := seedIfEmpty(seed, "backgrounds", filepath.Join(dir, "backgrounds")); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "backgrounds", "default.svg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "user-file" {
		t.Fatalf("seed overwrote user file: %q", body)
	}
}

func TestProxyRequiresAuthorization(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	for _, path := range []string{"/local-api/validate", "/local-api/search", "/local-api/chat"} {
		resp, err := http.Post(server.URL+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s with no key = %d, want 401", path, resp.StatusCode)
		}
	}
}

func TestValidateForwardsToUpstream(t *testing.T) {
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.URL.Path != "/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}))
	defer upstream.Close()

	app, _ := newTestApp(t, upstream.URL)
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/local-api/validate", nil)
	req.Header.Set("Authorization", "Bearer sk-test-1234567890")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}
	if gotAuth != "Bearer sk-test-1234567890" {
		t.Fatalf("auth forwarded = %q", gotAuth)
	}
}

func TestChatStreamsAndPreservesSSE(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode: %v", err)
			return
		}
		if payload["model"] != "deepseek-flash" {
			t.Errorf("model = %v", payload["model"])
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n"))
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer upstream.Close()

	app, _ := newTestApp(t, upstream.URL)
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	body := `{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}],"stream":true}`
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/local-api/chat", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-test-1234567890")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	text := string(raw)
	if !strings.Contains(text, `"你"`) || !strings.Contains(text, `"好"`) || !strings.Contains(text, "[DONE]") {
		t.Fatalf("stream body = %q", text)
	}
}

func TestUpstream401IsTranslatedWithoutEchoingKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"Authentication Fails, Your api key: ****cdef is invalid","type":"authentication_error"}}`))
	}))
	defer upstream.Close()

	app, _ := newTestApp(t, upstream.URL)
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/local-api/validate", nil)
	req.Header.Set("Authorization", "Bearer sk-test-1234567890abcdef")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(raw), "sk-") {
		t.Fatalf("response echoes key material: %s", raw)
	}
	if !strings.Contains(string(raw), "API Key 无效") {
		t.Fatalf("missing Chinese error: %s", raw)
	}
}

func TestMaskAPIKeys(t *testing.T) {
	cases := []struct{ in, want string }{
		{"key sk-abcdef123456 invalid", "key sk-*** invalid"},
		{"no secret here", "no secret here"},
		{"sk-123", "sk-123"},
		{"trailing sk-ZZZZZZZZZZZZ!", "trailing sk-***!"},
	}
	for _, c := range cases {
		if got := maskAPIKeys(c.in); got != c.want {
			t.Errorf("maskAPIKeys(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCrossOriginAPIRequestRejected(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	req, _ := http.NewRequest(http.MethodGet, server.URL+"/local-api/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestUnknownHostRejected(t *testing.T) {
	app, _ := newTestApp(t, "https://api.deepseek.com")
	server := httptest.NewServer(app.Handler())
	defer server.Close()

	req, _ := http.NewRequest(http.MethodGet, server.URL+"/local-api/health", nil)
	req.Host = "attacker.example:5199"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}
