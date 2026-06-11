package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// resolveSocketPath returns $MYMEM_SOCKET or the default userData socket.
func resolveSocketPath() (string, error) {
	if p := os.Getenv("MYMEM_SOCKET"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve home directory: %w", err)
	}
	return filepath.Join(home, "Library", "Application Support", "myMem", "api.sock"), nil
}

type client struct {
	socket string
	http   *http.Client
}

func newClient() (*client, error) {
	socket, err := resolveSocketPath()
	if err != nil {
		return nil, err
	}
	return &client{
		socket: socket,
		http: &http.Client{
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var d net.Dialer
					return d.DialContext(ctx, "unix", socket)
				},
			},
		},
	}, nil
}

// apiError is a non-2xx response from the server (exit code 1).
type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return e.Message }

// connError means the socket could not be reached (exit code 2).
type connError struct {
	Socket string
	Cause  error
}

func (e *connError) Error() string {
	msg := fmt.Sprintf("myMem is not running — open the app first (socket: %s)", e.Socket)
	if e.Cause != nil {
		msg += fmt.Sprintf("\n  transport error: %v", e.Cause)
	}
	return msg
}

// wrapDialError keeps the friendly message clean for the expected app-down
// cases (refused / missing socket) and carries detail for anything else.
func (c *client) wrapDialError(err error) error {
	var errno syscall.Errno
	if errors.As(err, &errno) && (errno == syscall.ECONNREFUSED || errno == syscall.ENOENT) {
		return &connError{Socket: c.socket}
	}
	if errors.Is(err, os.ErrNotExist) {
		return &connError{Socket: c.socket}
	}
	return &connError{Socket: c.socket, Cause: err}
}

// do performs one request and returns the raw response body.
func (c *client) do(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, "http://mymem"+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.wrapDialError(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := strings.TrimSpace(string(data))
		var parsed struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &parsed) == nil && parsed.Error != "" {
			msg = parsed.Error
		}
		if msg == "" {
			msg = fmt.Sprintf("API error %d", resp.StatusCode)
		}
		return nil, &apiError{Status: resp.StatusCode, Message: msg}
	}
	return data, nil
}

func (c *client) getJSON(path string, out any) error {
	data, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// ── Wire types (camelCase JSON, matching the server) ─────────────────────────

type note struct {
	ID              string   `json:"id"`
	Title           string   `json:"title"`
	ContentMd       string   `json:"contentMd"`
	CreatedAt       int64    `json:"createdAt"`
	UpdatedAt       int64    `json:"updatedAt"`
	TrashedAt       *int64   `json:"trashedAt"`
	Excerpt         string   `json:"excerpt"`
	CollectionIds   []string `json:"collectionIds"`
	CollectionNames []string `json:"collectionNames"`
}

type noteList struct {
	Items []note `json:"items"`
	Total int    `json:"total"`
}

type collection struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	NoteCount   int    `json:"noteCount"`
}

type searchResult struct {
	NoteID      string  `json:"noteId"`
	Title       string  `json:"title"`
	SnippetHTML string  `json:"snippetHtml"`
	Score       float64 `json:"score"`
}

type searchResponse struct {
	Results  []searchResult `json:"results"`
	UsedMode string         `json:"usedMode"`
}

type statusResponse struct {
	OK           bool   `json:"ok"`
	Version      string `json:"version"`
	Notes        int    `json:"notes"`
	PendingIndex int    `json:"pendingIndex"`
	Embeddings   string `json:"embeddings"`
}

type relatedNote struct {
	NoteID string  `json:"noteId"`
	Title  string  `json:"title"`
	Score  float64 `json:"score"`
}

type relatedCollection struct {
	CollectionID string  `json:"collectionId"`
	Name         string  `json:"name"`
	Score        float64 `json:"score"`
}

type relatedResponse struct {
	Notes             []relatedNote       `json:"notes"`
	Collections       []relatedCollection `json:"collections"`
	UnavailableReason string              `json:"unavailableReason"`
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

// resolveNoteID expands a short id (the 8-char id tails shown in human
// output) to the full UUIDv7 by scanning every live + trashed note. Suffix
// matches are tried first — that is what listings display (a UUIDv7 prefix is
// timestamp bits, non-unique within ~65 s) — then prefixes, for human-typed
// beginnings of full ids. Full-length ids pass through untouched.
func (c *client) resolveNoteID(id string) (string, error) {
	if len(id) >= 36 {
		return id, nil
	}
	var all []note
	for _, scope := range []string{"all", "trash"} {
		notes, err := c.notesInScope(scope)
		if err != nil {
			return "", err
		}
		all = append(all, notes...)
	}
	var matches []string
	for _, n := range all {
		if strings.HasSuffix(n.ID, id) {
			matches = append(matches, n.ID)
		}
	}
	if len(matches) == 0 {
		for _, n := range all {
			if strings.HasPrefix(n.ID, id) {
				matches = append(matches, n.ID)
			}
		}
	}
	switch len(matches) {
	case 0:
		return "", &apiError{Status: 404, Message: fmt.Sprintf("no note found with id %q", id)}
	case 1:
		return matches[0], nil
	default:
		return "", usagef("id %q is ambiguous (%d matches) — use the full id (see --json output)", id, len(matches))
	}
}

// notesInScope pages through GET /notes — the server caps each page at 500,
// so a single request would silently miss notes past the cap and could
// resolve a short id to the wrong note.
func (c *client) notesInScope(scope string) ([]note, error) {
	const pageSize = 500
	var all []note
	for offset := 0; ; offset += pageSize {
		var list noteList
		path := fmt.Sprintf("/notes?scope=%s&limit=%d&offset=%d", scope, pageSize, offset)
		if err := c.getJSON(path, &list); err != nil {
			return nil, err
		}
		all = append(all, list.Items...)
		if len(list.Items) < pageSize || len(all) >= list.Total {
			return all, nil
		}
	}
}

func (c *client) collectionIDByName(name string) (string, error) {
	var cols []collection
	if err := c.getJSON("/collections", &cols); err != nil {
		return "", err
	}
	for _, col := range cols {
		if strings.EqualFold(col.Name, name) {
			return col.ID, nil
		}
	}
	return "", &apiError{Status: 404, Message: fmt.Sprintf("collection not found: %s", name)}
}
