package main

import (
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
)

// shortID is the LAST 8 chars of the UUIDv7 — its random tail. The first
// chars are the timestamp, so prefixes of ids minted within the same ~65 s
// window all collide.
func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[len(id)-8:]
}

func titleOr(title string) string {
	if strings.TrimSpace(title) == "" {
		return "(untitled)"
	}
	return title
}

func formatTime(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

var markStripper = strings.NewReplacer("<mark>", "", "</mark>", "", "\n", " ")

func plainSnippet(snippetHTML string) string {
	return strings.TrimSpace(markStripper.Replace(snippetHTML))
}

// printRaw writes the exact server JSON (machine output) plus a trailing newline.
func printRaw(w io.Writer, raw []byte) error {
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if len(raw) == 0 || raw[len(raw)-1] != '\n' {
		_, err := io.WriteString(w, "\n")
		return err
	}
	return nil
}

func newTable(w io.Writer) *tabwriter.Writer {
	return tabwriter.NewWriter(w, 2, 4, 2, ' ', 0)
}

func renderNoteTable(w io.Writer, items []note, pinnedIDs map[string]bool) {
	tw := newTable(w)
	fmt.Fprintln(tw, "ID\tUPDATED\tTITLE")
	for _, n := range items {
		title := titleOr(n.Title)
		if pinnedIDs[n.ID] {
			title = "📌 " + title
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", shortID(n.ID), formatTime(n.UpdatedAt), title)
	}
	tw.Flush()
}

func renderSearchTable(w io.Writer, results []searchResult) {
	tw := newTable(w)
	fmt.Fprintln(tw, "ID\tTITLE\tSNIPPET")
	for _, r := range results {
		fmt.Fprintf(tw, "%s\t%s\t%s\n", shortID(r.NoteID), titleOr(r.Title), plainSnippet(r.SnippetHTML))
	}
	tw.Flush()
}

func renderCollectionsTable(w io.Writer, cols []collection) {
	tw := newTable(w)
	fmt.Fprintln(tw, "ID\tNOTES\tNAME\tDESCRIPTION")
	for _, c := range cols {
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\n", shortID(c.ID), c.NoteCount, c.Name, c.Description)
	}
	tw.Flush()
}

func renderNote(w io.Writer, n note) {
	fmt.Fprintln(w, titleOr(n.Title))
	meta := fmt.Sprintf("id: %s · updated: %s", n.ID, formatTime(n.UpdatedAt))
	if len(n.CollectionNames) > 0 {
		meta += " · collections: " + strings.Join(n.CollectionNames, ", ")
	}
	if n.TrashedAt != nil {
		meta += " · IN TRASH"
	}
	fmt.Fprintln(w, meta)
	fmt.Fprintln(w)
	content := strings.TrimRight(n.ContentMd, "\n")
	if content == "" {
		fmt.Fprintln(w, "(empty)")
		return
	}
	fmt.Fprintln(w, content)
}
