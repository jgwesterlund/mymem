package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// cannedStatusJSON is written verbatim by the fake — the passthrough test
// asserts --json emits the exact server bytes.
const cannedStatusJSON = `{"ok":true,"version":"9.9.9","notes":3,"pendingIndex":1,"embeddings":"ready"}`

type fakeStore struct {
	mu    sync.Mutex
	notes map[string]*note
	order []string
	seq   int
}

// add seeds a note directly (tests that need many notes skip the HTTP hop).
// Ids share a long prefix but get distinct suffixes — like real UUIDv7s
// minted in one burst.
func (st *fakeStore) add(title string) *note {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.addLocked(title)
}

func (st *fakeStore) addLocked(title string) *note {
	st.seq++
	id := fmt.Sprintf("0196aaaa-bbbb-7ccc-8ddd-%012d", st.seq)
	n := &note{
		ID:        id,
		Title:     title,
		CreatedAt: 1700000000000,
		UpdatedAt: 1700000000000,
	}
	st.notes[id] = n
	st.order = append(st.order, id)
	return n
}

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSONStatus(w, status, map[string]string{"error": msg})
}

// newFakeAPI implements the endpoints the CLI talks to with an in-memory store.
func newFakeAPI(st *fakeStore) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, cannedStatusJSON)
	})

	mux.HandleFunc("POST /notes", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title           string   `json:"title"`
			ContentMd       string   `json:"contentMd"`
			CollectionNames []string `json:"collectionNames"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "invalid JSON body")
			return
		}
		st.mu.Lock()
		n := st.addLocked(body.Title)
		n.ContentMd = body.ContentMd
		n.CollectionNames = body.CollectionNames
		st.mu.Unlock()
		writeJSONStatus(w, 201, n)
	})

	mux.HandleFunc("GET /notes", func(w http.ResponseWriter, r *http.Request) {
		scope := r.URL.Query().Get("scope")
		limit := 100
		if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
			limit = v
		}
		if limit > 500 {
			limit = 500 // the real server caps each page at 500
		}
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		st.mu.Lock()
		all := []note{}
		for _, id := range st.order {
			n := st.notes[id]
			trashed := n.TrashedAt != nil
			if (scope == "trash") != trashed {
				continue
			}
			all = append(all, *n)
		}
		st.mu.Unlock()
		total := len(all)
		if offset > total {
			offset = total
		}
		end := offset + limit
		if end > total {
			end = total
		}
		writeJSONStatus(w, 200, map[string]any{"items": all[offset:end], "total": total})
	})

	mux.HandleFunc("GET /notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		n, ok := st.notes[r.PathValue("id")]
		st.mu.Unlock()
		if !ok {
			writeErr(w, 404, "note not found: "+r.PathValue("id"))
			return
		}
		writeJSONStatus(w, 200, n)
	})

	mux.HandleFunc("PATCH /notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode      string  `json:"mode"`
			ContentMd *string `json:"contentMd"`
			Title     *string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "invalid JSON body")
			return
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		n, ok := st.notes[r.PathValue("id")]
		if !ok {
			writeErr(w, 404, "note not found: "+r.PathValue("id"))
			return
		}
		if n.TrashedAt != nil {
			writeErr(w, 409, "note is in the trash")
			return
		}
		if body.Title != nil {
			n.Title = *body.Title
		}
		if body.ContentMd != nil {
			if body.Mode == "append" && n.ContentMd != "" {
				n.ContentMd += "\n\n" + *body.ContentMd
			} else {
				n.ContentMd = *body.ContentMd
			}
		}
		writeJSONStatus(w, 200, n)
	})

	mux.HandleFunc("DELETE /notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		defer st.mu.Unlock()
		n, ok := st.notes[r.PathValue("id")]
		if !ok {
			writeErr(w, 404, "note not found: "+r.PathValue("id"))
			return
		}
		ts := int64(1700000001000)
		n.TrashedAt = &ts
		writeJSONStatus(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("GET /search", func(w http.ResponseWriter, r *http.Request) {
		q := strings.ToLower(r.URL.Query().Get("q"))
		mode := r.URL.Query().Get("mode")
		if mode == "" {
			mode = "keyword"
		}
		st.mu.Lock()
		results := []searchResult{}
		for _, id := range st.order {
			n := st.notes[id]
			if n.TrashedAt != nil {
				continue
			}
			if strings.Contains(strings.ToLower(n.Title+" "+n.ContentMd), q) {
				results = append(results, searchResult{
					NoteID:      n.ID,
					Title:       n.Title,
					SnippetHTML: "…<mark>" + q + "</mark>…",
					Score:       1,
				})
			}
		}
		st.mu.Unlock()
		writeJSONStatus(w, 200, map[string]any{"results": results, "usedMode": mode})
	})

	mux.HandleFunc("GET /collections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSONStatus(w, 200, []collection{})
	})

	return mux
}

// startFake serves the fake API on a real unix socket and returns its path.
func startFake(t *testing.T) string {
	t.Helper()
	sock, _ := startFakeWithStore(t)
	return sock
}

// startFakeWithStore also exposes the backing store for direct seeding.
func startFakeWithStore(t *testing.T) (string, *fakeStore) {
	t.Helper()
	dir, err := os.MkdirTemp("", "mym-test") // NOT t.TempDir: socket paths must stay under 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	st := &fakeStore{notes: map[string]*note{}}
	srv := httptest.NewUnstartedServer(newFakeAPI(st))
	_ = srv.Listener.Close() // swap the default TCP listener for our unix socket
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return sock, st
}

// runCLI exercises the real run() entrypoint and captures output + exit code.
func runCLI(args ...string) (stdout, stderr string, code int) {
	var out, errOut bytes.Buffer
	code = run(args, &out, &errOut)
	return out.String(), errOut.String(), code
}

func mustCreate(t *testing.T, args ...string) note {
	t.Helper()
	out, errOut, code := runCLI(append([]string{"create"}, args...)...)
	if code != 0 {
		t.Fatalf("create failed (code %d): %s", code, errOut)
	}
	var n note
	if err := json.Unmarshal([]byte(out), &n); err != nil {
		t.Fatalf("create --json output is not JSON: %v\n%s", err, out)
	}
	return n
}

func TestCreateSearchGetRoundtrip(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))

	n := mustCreate(t, "--title", "Roundtrip note", "--json", "alpha", "beta", "uniquemarker")
	if len(n.ID) != 36 {
		t.Fatalf("expected full UUID id, got %q", n.ID)
	}
	if n.ContentMd != "alpha beta uniquemarker" {
		t.Fatalf("content args were not joined: %q", n.ContentMd)
	}

	out, errOut, code := runCLI("search", "uniquemarker")
	if code != 0 {
		t.Fatalf("search failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "Roundtrip note") || !strings.Contains(out, shortID(n.ID)) {
		t.Fatalf("search output missing the note:\n%s", out)
	}

	out, errOut, code = runCLI("get", n.ID)
	if code != 0 {
		t.Fatalf("get failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "Roundtrip note") || !strings.Contains(out, "alpha beta uniquemarker") {
		t.Fatalf("get output missing title/content:\n%s", out)
	}
}

func TestAppendFlow(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))

	n := mustCreate(t, "--title", "Append target", "--json", "first", "part")
	out, errOut, code := runCLI("append", n.ID, "second", "part")
	if code != 0 {
		t.Fatalf("append failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "appended to "+shortID(n.ID)) {
		t.Fatalf("append confirmation missing:\n%s", out)
	}

	out, _, code = runCLI("get", n.ID)
	if code != 0 {
		t.Fatalf("get after append failed (code %d)", code)
	}
	if !strings.Contains(out, "first part\n\nsecond part") {
		t.Fatalf("appended content not joined with a blank line:\n%s", out)
	}
}

func TestAppendFromStdin(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	n := mustCreate(t, "--title", "Stdin target", "--json", "base")

	orig := stdin
	stdin = strings.NewReader("piped tail\n")
	defer func() { stdin = orig }()

	_, errOut, code := runCLI("append", n.ID)
	if code != 0 {
		t.Fatalf("stdin append failed (code %d): %s", code, errOut)
	}
	out, _, _ := runCLI("get", n.ID)
	if !strings.Contains(out, "base\n\npiped tail") {
		t.Fatalf("stdin content not appended:\n%s", out)
	}
}

func TestUpdateReplaces(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	n := mustCreate(t, "--title", "Replace target", "--json", "old", "body")

	_, errOut, code := runCLI("update", n.ID, "brand", "new", "body")
	if code != 0 {
		t.Fatalf("update failed (code %d): %s", code, errOut)
	}
	out, _, _ := runCLI("get", n.ID)
	if strings.Contains(out, "old body") || !strings.Contains(out, "brand new body") {
		t.Fatalf("update did not replace the content:\n%s", out)
	}
}

func TestJSONPassthrough(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))

	out, errOut, code := runCLI("status", "--json")
	if code != 0 {
		t.Fatalf("status --json failed (code %d): %s", code, errOut)
	}
	if out != cannedStatusJSON+"\n" {
		t.Fatalf("--json must pass the server bytes through verbatim:\ngot  %q\nwant %q", out, cannedStatusJSON+"\n")
	}
}

func TestShortIDSuffixResolution(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	// Two notes minted in the same burst: ids share their prefix (UUIDv7
	// timestamp bits) and differ only in the suffix — like the real thing.
	n1 := mustCreate(t, "--title", "Suffix one", "--json", "bodyone")
	n2 := mustCreate(t, "--title", "Suffix two", "--json", "bodytwo")
	if shortID(n1.ID) != n1.ID[len(n1.ID)-8:] {
		t.Fatalf("shortID must display the id tail, got %q for %q", shortID(n1.ID), n1.ID)
	}
	if shortID(n1.ID) == shortID(n2.ID) {
		t.Fatalf("test ids must have distinct suffixes: %q vs %q", n1.ID, n2.ID)
	}

	// The displayed 8-char short id must resolve back to the right note.
	out, errOut, code := runCLI("get", shortID(n1.ID))
	if code != 0 {
		t.Fatalf("get by displayed short id failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "Suffix one") || !strings.Contains(out, n1.ID) {
		t.Fatalf("short-id get returned the wrong note:\n%s", out)
	}
}

func TestIDPrefixResolution(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	n := mustCreate(t, "--title", "Prefix me", "--json", "prefixbody")

	// Human-typed beginnings of the full id keep working when unique.
	out, errOut, code := runCLI("get", n.ID[:8])
	if code != 0 {
		t.Fatalf("get by unique prefix failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "Prefix me") || !strings.Contains(out, n.ID) {
		t.Fatalf("prefix get returned the wrong note:\n%s", out)
	}
}

func TestAmbiguousIDErrorsLoudly(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	mustCreate(t, "--title", "Twin A", "--json", "bodya")
	mustCreate(t, "--title", "Twin B", "--json", "bodyb")

	// "0196aaaa" prefixes BOTH ids (and suffixes neither) — same-burst UUIDv7
	// collision. Resolution must refuse, not pick one.
	out, errOut, code := runCLI("get", "0196aaaa")
	if code != 2 {
		t.Fatalf("ambiguous id must exit 2, got %d (stdout: %s)", code, out)
	}
	if !strings.Contains(errOut, "ambiguous") || !strings.Contains(errOut, "2 matches") {
		t.Fatalf("ambiguity error missing detail:\n%s", errOut)
	}
}

func TestIDResolutionPagesPastServerCap(t *testing.T) {
	sock, st := startFakeWithStore(t)
	t.Setenv("MYMEM_SOCKET", sock)
	var target *note
	for i := 1; i <= 620; i++ {
		target = st.add(fmt.Sprintf("Bulk note %d", i))
	}

	// The target sits past the server's 500-per-page cap: resolution must
	// page with offset, not silently search only the first page.
	out, errOut, code := runCLI("get", shortID(target.ID))
	if code != 0 {
		t.Fatalf("get past the 500-note page failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, target.ID) || !strings.Contains(out, "Bulk note 620") {
		t.Fatalf("resolved the wrong note:\n%s", out)
	}
}

func TestConnectionRefusedDeadSocket(t *testing.T) {
	dir, err := os.MkdirTemp("", "mym-dead")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	// A genuinely dead socket: the file exists but nothing accepts → ECONNREFUSED.
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = ln.Close()
	t.Setenv("MYMEM_SOCKET", sock)

	out, errOut, code := runCLI("status")
	if code != 2 {
		t.Fatalf("dead socket must exit 2, got %d (stderr: %s)", code, errOut)
	}
	if !strings.Contains(errOut, "myMem is not running — open the app first") {
		t.Fatalf("missing friendly app-down message:\n%s", errOut)
	}
	if !strings.Contains(errOut, sock) {
		t.Fatalf("message must include the socket path:\n%s", errOut)
	}
	if out != "" {
		t.Fatalf("stdout must stay empty on connection errors:\n%s", out)
	}
}

func TestConnectionMissingSocket(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", "/nonexistent/dir/api.sock")
	_, errOut, code := runCLI("list")
	if code != 2 {
		t.Fatalf("missing socket must exit 2, got %d", code)
	}
	if !strings.Contains(errOut, "myMem is not running — open the app first") {
		t.Fatalf("missing friendly app-down message:\n%s", errOut)
	}
}

func TestAPIErrorExitCode(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	_, errOut, code := runCLI("get", "0196aaaa-bbbb-7ccc-8ddd-999999999999")
	if code != 1 {
		t.Fatalf("API 404 must exit 1, got %d", code)
	}
	if !strings.Contains(errOut, "note not found") {
		t.Fatalf("stderr must carry the server error message:\n%s", errOut)
	}
}

func TestUsageErrors(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	cases := [][]string{
		{},                        // no command
		{"bogus"},                 // unknown command
		{"search"},                // missing query
		{"get"},                   // missing id
		{"search", "--nope", "q"}, // unknown flag
	}
	for _, args := range cases {
		if _, _, code := runCLI(args...); code != 2 {
			t.Errorf("args %v: want exit 2, got %d", args, code)
		}
	}
}

func TestTrashFlow(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	n := mustCreate(t, "--title", "Doomed", "--json", "doomedbody")

	out, errOut, code := runCLI("trash", n.ID)
	if code != 0 {
		t.Fatalf("trash failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "trashed "+shortID(n.ID)) {
		t.Fatalf("trash confirmation missing:\n%s", out)
	}
	searchOut, _, _ := runCLI("search", "doomedbody")
	if strings.Contains(searchOut, shortID(n.ID)) {
		t.Fatalf("trashed note still in search results:\n%s", searchOut)
	}
	listOut, _, _ := runCLI("list", "--trash")
	if !strings.Contains(listOut, shortID(n.ID)) {
		t.Fatalf("trashed note missing from list --trash:\n%s", listOut)
	}
}

func TestDoubleDashContent(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))

	// create: everything after a bare '--' is content, even list lines.
	n := mustCreate(t, "--title", "List note", "--json", "--", "- milk", "- eggs")
	if n.ContentMd != "- milk - eggs" {
		t.Fatalf("'--' content not taken verbatim: %q", n.ContentMd)
	}

	// append: dash-prefixed content after '--' must not be parsed as flags.
	out, errOut, code := runCLI("append", n.ID, "--", "- buy milk")
	if code != 0 {
		t.Fatalf("append with '--' failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "appended to "+shortID(n.ID)) {
		t.Fatalf("append confirmation missing:\n%s", out)
	}
	got, _, _ := runCLI("get", n.ID)
	if !strings.Contains(got, "- milk - eggs\n\n- buy milk") {
		t.Fatalf("dash content not appended:\n%s", got)
	}

	// even a string that looks exactly like a known flag is content after '--'.
	n2 := mustCreate(t, "--title", "Tricky", "--json", "--", "--json")
	if n2.ContentMd != "--json" {
		t.Fatalf("'--' did not protect a flag-shaped positional: %q", n2.ContentMd)
	}
}

func TestFlagsAfterPositionals(t *testing.T) {
	t.Setenv("MYMEM_SOCKET", startFake(t))
	mustCreate(t, "--title", "Interleaved", "--json", "interleavedmarker")

	// the spec's documented shape: mym search "query" --deep
	out, errOut, code := runCLI("search", "interleavedmarker", "--limit", "5")
	if code != 0 {
		t.Fatalf("flags after positionals failed (code %d): %s", code, errOut)
	}
	if !strings.Contains(out, "Interleaved") {
		t.Fatalf("interleaved search missed the note:\n%s", out)
	}
}
