// Command mym talks to the myMem app's local API (HTTP over a unix socket).
//
// Exit codes: 0 success · 1 API error · 2 connection or usage error.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// stdin is swappable for tests.
var stdin io.Reader = os.Stdin

const usageText = `mym — myMem notes from the command line

Usage:
  mym status
  mym list [--collection NAME] [--trash] [--limit N]
  mym search "query" [--deep] [--collection NAME] [--limit N]
  mym get <id>
  mym create --title T [--collection NAME]... [content|-]
  mym append <id> [content|-]
  mym update <id> [content|-]
  mym collections
  mym pin <id>
  mym unpin <id>
  mym trash <id>
  mym related <id> [--broaden]

Every command accepts --json for the exact server JSON (full ids,
machine-readable). Content is markdown; '-' reads it from stdin (append and
update also read stdin when no content argument is given), and a bare '--'
stops flag parsing so content may start with '-'. Note ids may be passed in
full, as the 8-char short ids shown in listings (the tail of the full id),
or as a unique prefix of the full id.

Socket: $MYMEM_SOCKET or ~/Library/Application Support/myMem/api.sock
`

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

// run is the testable entrypoint: it dispatches a subcommand and maps errors
// to exit codes (0 ok, 1 API error, 2 connection/usage).
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usageText)
		return 2
	}
	cmd, rest := args[0], args[1:]
	var err error
	switch cmd {
	case "status":
		err = cmdStatus(rest, stdout)
	case "list":
		err = cmdList(rest, stdout)
	case "search":
		err = cmdSearch(rest, stdout)
	case "get":
		err = cmdGet(rest, stdout)
	case "create":
		err = cmdCreate(rest, stdout)
	case "append":
		err = cmdEdit(rest, stdout, "append")
	case "update":
		err = cmdEdit(rest, stdout, "replace")
	case "collections":
		err = cmdCollections(rest, stdout)
	case "pin":
		err = cmdPin(rest, stdout, true)
	case "unpin":
		err = cmdPin(rest, stdout, false)
	case "trash":
		err = cmdTrash(rest, stdout)
	case "related":
		err = cmdRelated(rest, stdout)
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usageText)
		return 0
	default:
		fmt.Fprintf(stderr, "mym: unknown command %q\n\n%s", cmd, usageText)
		return 2
	}
	return report(err, stderr)
}

func report(err error, stderr io.Writer) int {
	if err == nil {
		return 0
	}
	var usageErr *usageError
	var connE *connError
	switch {
	case errors.As(err, &usageErr):
		fmt.Fprintf(stderr, "mym: %s\n", err)
		return 2
	case errors.As(err, &connE):
		fmt.Fprintf(stderr, "%s\n", err)
		return 2
	default:
		fmt.Fprintf(stderr, "mym: %s\n", err)
		return 1
	}
}

type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error {
	return &usageError{msg: fmt.Sprintf(format, args...)}
}

// parseInterleaved parses flags that may appear before or after positional
// arguments (stdlib flag stops at the first positional, so loop). A bare "--"
// ends flag parsing for good: everything after it is positional verbatim, so
// content may start with '-' (e.g. markdown list lines). The split happens
// BEFORE the parse loop — re-parsing the remainder would otherwise treat
// dash-prefixed content as flags again.
func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(io.Discard)
	var verbatim []string
	for i, a := range args {
		if a == "--" {
			args, verbatim = args[:i], args[i+1:]
			break
		}
	}
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, &usageError{msg: err.Error()}
		}
		args = fs.Args()
		if len(args) == 0 {
			return append(positional, verbatim...), nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

// repeatedFlag collects a repeatable string flag (e.g. --collection A --collection B).
type repeatedFlag []string

func (r *repeatedFlag) String() string { return strings.Join(*r, ",") }

func (r *repeatedFlag) Set(v string) error {
	*r = append(*r, v)
	return nil
}

// contentFrom assembles markdown content from positional args. A lone "-"
// reads stdin; with stdinDefault, zero args also read stdin (pipe-friendly).
func contentFrom(args []string, stdinDefault bool) (string, error) {
	readStdin := (len(args) == 1 && args[0] == "-") || (len(args) == 0 && stdinDefault)
	if readStdin {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return "", err
		}
		return strings.TrimRight(string(data), "\n"), nil
	}
	return strings.Join(args, " "), nil
}

// ── Subcommands ───────────────────────────────────────────────────────────────

func cmdStatus(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	raw, err := c.do("GET", "/status", nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var st statusResponse
	if err := json.Unmarshal(raw, &st); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "myMem v%s — %d notes, %d pending index, embeddings: %s\n",
		st.Version, st.Notes, st.PendingIndex, st.Embeddings)
	return nil
}

func cmdList(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	collectionName := fs.String("collection", "", "filter by collection name")
	trash := fs.Bool("trash", false, "list trashed notes")
	limit := fs.Int("limit", 50, "max notes")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	if *collectionName != "" && *trash {
		return usagef("--collection and --trash cannot be combined")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("scope", "all")
	q.Set("limit", strconv.Itoa(*limit))
	if *trash {
		q.Set("scope", "trash")
	}
	if *collectionName != "" {
		id, err := c.collectionIDByName(*collectionName)
		if err != nil {
			return err
		}
		q.Set("scope", "collection")
		q.Set("collectionId", id)
	}
	raw, err := c.do("GET", "/notes?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var list noteList
	if err := json.Unmarshal(raw, &list); err != nil {
		return err
	}
	if len(list.Items) == 0 {
		fmt.Fprintln(stdout, "no notes")
		return nil
	}
	var pinnedIDs map[string]bool
	if !*trash { // trashed notes are never pinned (trash clears pins)
		pinnedIDs = c.pinnedNoteIDs()
	}
	renderNoteTable(stdout, list.Items, pinnedIDs)
	if list.Total > len(list.Items) {
		fmt.Fprintf(stdout, "(%d of %d — raise --limit to see more, up to the server cap of 500 per request)\n",
			len(list.Items), list.Total)
	}
	return nil
}

func cmdSearch(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	deep := fs.Bool("deep", false, "semantic deep search")
	collectionName := fs.String("collection", "", "filter by collection name")
	limit := fs.Int("limit", 20, "max results")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return usagef(`usage: mym search "query" [--deep] [--collection NAME] [--limit N]`)
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("q", strings.Join(pos, " "))
	q.Set("limit", strconv.Itoa(*limit))
	mode := "keyword"
	if *deep {
		mode = "deep"
	}
	q.Set("mode", mode)
	if *collectionName != "" {
		id, err := c.collectionIDByName(*collectionName)
		if err != nil {
			return err
		}
		q.Set("collectionId", id)
	}
	raw, err := c.do("GET", "/search?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var resp searchResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return err
	}
	if *deep && resp.UsedMode != "deep" {
		fmt.Fprintln(stdout, "(deep search unavailable — fell back to keyword)")
	}
	if len(resp.Results) == 0 {
		fmt.Fprintln(stdout, "no results")
		return nil
	}
	renderSearchTable(stdout, resp.Results)
	return nil
}

func cmdGet(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("get", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usagef("usage: mym get <id>")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	id, err := c.resolveNoteID(pos[0])
	if err != nil {
		return err
	}
	raw, err := c.do("GET", "/notes/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var n note
	if err := json.Unmarshal(raw, &n); err != nil {
		return err
	}
	renderNote(stdout, n)
	return nil
}

func cmdCreate(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("create", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	title := fs.String("title", "", "note title")
	var collections repeatedFlag
	fs.Var(&collections, "collection", "collection name (repeatable, created if missing)")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	// No content args and no '-': create an empty note (don't block on a TTY).
	content, err := contentFrom(pos, false)
	if err != nil {
		return err
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	body := map[string]any{"title": *title, "contentMd": content}
	if len(collections) > 0 {
		body["collectionNames"] = []string(collections)
	}
	raw, err := c.do("POST", "/notes", body)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var n note
	if err := json.Unmarshal(raw, &n); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "created %s  %s\n", shortID(n.ID), titleOr(n.Title))
	return nil
}

// cmdEdit handles both `mym append` (mode "append") and `mym update` (mode "replace").
func cmdEdit(args []string, stdout io.Writer, mode string) error {
	verb := "append"
	if mode == "replace" {
		verb = "update"
	}
	fs := flag.NewFlagSet(verb, flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) == 0 {
		return usagef("usage: mym %s <id> [content|-]", verb)
	}
	content, err := contentFrom(pos[1:], true)
	if err != nil {
		return err
	}
	if content == "" {
		return usagef("no content given — pass content args, '-', or pipe stdin")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	id, err := c.resolveNoteID(pos[0])
	if err != nil {
		return err
	}
	raw, err := c.do("PATCH", "/notes/"+url.PathEscape(id), map[string]any{"mode": mode, "contentMd": content})
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var n note
	if err := json.Unmarshal(raw, &n); err != nil {
		return err
	}
	if mode == "append" {
		fmt.Fprintf(stdout, "appended to %s  %s\n", shortID(n.ID), titleOr(n.Title))
	} else {
		fmt.Fprintf(stdout, "updated %s  %s\n", shortID(n.ID), titleOr(n.Title))
	}
	return nil
}

func cmdCollections(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("collections", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	if _, err := parseInterleaved(fs, args); err != nil {
		return err
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	raw, err := c.do("GET", "/collections", nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var cols []collection
	if err := json.Unmarshal(raw, &cols); err != nil {
		return err
	}
	if len(cols) == 0 {
		fmt.Fprintln(stdout, "no collections")
		return nil
	}
	renderCollectionsTable(stdout, cols)
	return nil
}

// cmdPin handles both `mym pin` (pinned=true) and `mym unpin` (pinned=false) —
// the note shows up in (or leaves) the app sidebar's Pinned section.
func cmdPin(args []string, stdout io.Writer, pinned bool) error {
	verb := "pin"
	if !pinned {
		verb = "unpin"
	}
	fs := flag.NewFlagSet(verb, flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usagef("usage: mym %s <id>", verb)
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	id, err := c.resolveNoteID(pos[0])
	if err != nil {
		return err
	}
	raw, err := c.do("PUT", "/notes/"+url.PathEscape(id)+"/pin", map[string]any{"pinned": pinned})
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var n note
	if err := json.Unmarshal(raw, &n); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "%sned %s  %s\n", verb, shortID(n.ID), titleOr(n.Title))
	return nil
}

func cmdTrash(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("trash", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usagef("usage: mym trash <id>")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	id, err := c.resolveNoteID(pos[0])
	if err != nil {
		return err
	}
	raw, err := c.do("DELETE", "/notes/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	fmt.Fprintf(stdout, "trashed %s\n", shortID(id))
	return nil
}

func cmdRelated(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("related", flag.ContinueOnError)
	jsonOut := fs.Bool("json", false, "raw JSON output")
	broaden := fs.Bool("broaden", false, "wider net, lower threshold")
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return usagef("usage: mym related <id> [--broaden]")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	id, err := c.resolveNoteID(pos[0])
	if err != nil {
		return err
	}
	path := "/notes/" + url.PathEscape(id) + "/related"
	if *broaden {
		path += "?broaden=true"
	}
	raw, err := c.do("GET", path, nil)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printRaw(stdout, raw)
	}
	var resp relatedResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return err
	}
	if resp.UnavailableReason != "" {
		fmt.Fprintf(stdout, "(related unavailable: %s)\n", resp.UnavailableReason)
		return nil
	}
	if len(resp.Notes) == 0 {
		fmt.Fprintln(stdout, "no related notes")
		return nil
	}
	tw := newTable(stdout)
	fmt.Fprintln(tw, "ID\tSCORE\tTITLE")
	for _, n := range resp.Notes {
		fmt.Fprintf(tw, "%s\t%.3f\t%s\n", shortID(n.NoteID), n.Score, titleOr(n.Title))
	}
	tw.Flush()
	if len(resp.Collections) > 0 {
		names := make([]string, len(resp.Collections))
		for i, col := range resp.Collections {
			names[i] = col.Name
		}
		fmt.Fprintf(stdout, "related collections: %s\n", strings.Join(names, ", "))
	}
	return nil
}
