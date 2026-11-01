package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxRequestBody = 4 << 20 // 4 MiB

type upstreamError struct {
	Status  int
	Message string
}

func (e *upstreamError) Error() string { return e.Message }

func (a *App) handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	apiKey, ok := bearerToken(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "请先输入有效的 DeepSeek API Key。")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.upstreamBase+"/models", nil)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "无法创建校验请求。")
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := a.client.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "无法连接 DeepSeek，请检查网络后重试。")
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode != http.StatusOK {
		writeUpstreamFailure(w, resp.StatusCode, body)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": "API Key 校验通过。",
	})
}

func (a *App) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	apiKey, ok := bearerToken(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "请先输入有效的 DeepSeek API Key。")
		return
	}
	payload, err := readLimitedJSON(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "搜索请求格式不正确。")
		return
	}
	if err := validateSearchPayload(payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	body, err := json.Marshal(payload)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "搜索请求格式不正确。")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.upstreamBase+"/v1/tools/search", bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "无法创建搜索请求。")
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := a.client.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "联网搜索失败，请检查网络后重试。")
		return
	}
	defer resp.Body.Close()
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		writeUpstreamFailure(w, resp.StatusCode, responseBody)
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(responseBody)
}

func (a *App) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	apiKey, ok := bearerToken(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "请先输入有效的 DeepSeek API Key。")
		return
	}
	payload, err := readLimitedJSON(r)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "对话请求格式不正确。")
		return
	}
	if err := validateChatPayload(payload); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	body, err := json.Marshal(payload)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, "对话请求格式不正确。")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.upstreamBase+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "无法创建对话请求。")
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := a.client.Do(req)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "无法连接 DeepSeek，请检查网络后重试。")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		writeUpstreamFailure(w, resp.StatusCode, responseBody)
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "text/event-stream; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}

	buf := make([]byte, 16*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				// The status line has already been sent, so the only useful
				// signal left is to close the stream. The UI shows an
				// interrupted-answer state.
				return
			}
			return
		}
	}
}

func bearerToken(r *http.Request) (string, bool) {
	value := strings.TrimSpace(r.Header.Get("Authorization"))
	if value == "" {
		return "", false
	}
	if len(value) < 8 || !strings.EqualFold(value[:7], "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(value[7:])
	if token == "" {
		return "", false
	}
	return token, true
}

func readLimitedJSON(r *http.Request) (map[string]any, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxRequestBody {
		return nil, fmt.Errorf("请求体过大")
	}
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return nil, err
	}
	if payload == nil {
		return nil, fmt.Errorf("请求体为空")
	}
	return payload, nil
}

func validateSearchPayload(payload map[string]any) error {
	query, ok := payload["query"].(string)
	if !ok || strings.TrimSpace(query) == "" {
		return fmt.Errorf("搜索词不能为空")
	}
	if len([]rune(query)) > 128 {
		return fmt.Errorf("搜索词过长")
	}
	if _, exists := payload["count"]; !exists {
		payload["count"] = 5
	}
	if _, exists := payload["need_content"]; !exists {
		payload["need_content"] = false
	}
	return nil
}

func validateChatPayload(payload map[string]any) error {
	model, ok := payload["model"].(string)
	if !ok || strings.TrimSpace(model) == "" {
		return fmt.Errorf("缺少模型名称")
	}
	messages, ok := payload["messages"].([]any)
	if !ok || len(messages) == 0 {
		return fmt.Errorf("缺少对话消息")
	}
	return nil
}

func writeUpstreamFailure(w http.ResponseWriter, status int, body []byte) {
	providerMessage := extractUpstreamMessage(body)
	message := providerMessage
	switch status {
	case http.StatusUnauthorized:
		// Keep the UI Chinese and never echo a provider message that can
		// contain part of the submitted key.
		message = "API Key 无效，请检查后重试。"
	case http.StatusPaymentRequired:
		message = "DeepSeek 账户余额不足，请充值后重试。"
	case http.StatusTooManyRequests:
		message = "请求过于频繁，请稍后重试。"
	case http.StatusForbidden:
		if message == "" {
			message = "该请求被 DeepSeek 拒绝。"
		}
	}
	if message == "" {
		message = "DeepSeek 返回了错误，请稍后重试。"
	}
	writeJSONError(w, status, message)
}

func extractUpstreamMessage(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		message := strings.TrimSpace(payload.Error.Message)
		if message != "" {
			return trimProviderNoise(message)
		}
	}
	// /models can return plain text errors instead of JSON.
	text := strings.TrimSpace(string(body))
	if len(text) > 0 && len(text) < 300 && !strings.ContainsAny(text, "{}<>") {
		return trimProviderNoise(text)
	}
	return ""
}

func trimProviderNoise(message string) string {
	// Avoid ever surfacing a full API key if a provider includes it in an
	// error string. DeepSeek normally masks it, but the local app should not
	// rely on that behaviour.
	message = maskAPIKeys(message)
	runes := []rune(message)
	if len(runes) > 280 {
		message = string(runes[:280]) + "…"
	}
	return message
}

func maskAPIKeys(message string) string {
	// Keep the optional provider prefix, redact the secret-looking tail.
	if len(message) < 8 {
		return message
	}
	var out strings.Builder
	for i := 0; i < len(message); {
		if strings.HasPrefix(message[i:], "sk-") {
			end := i + 3
			for end < len(message) {
				c := message[end]
				if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' {
					end++
					continue
				}
				break
			}
			if end-(i+3) >= 6 {
				out.WriteString("sk-***")
				i = end
				continue
			}
		}
		out.WriteByte(message[i])
		i++
	}
	return out.String()
}
