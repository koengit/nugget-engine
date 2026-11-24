# Nugget engine

A small, dependency-free system for publishing course material as **nuggets**: short, self-contained pieces of content (a definition with examples, a lemma with its proof, an alternative proof, a worked example, an exercise with an answer, …) that link to each other and can be grouped in overlapping ways.

The engine is separate from the content. A *nugget collection* (an "instance") is a directory of Markdown files; this engine turns it into a static website that runs on any static host, including GitHub Pages.

## What students get

- Browse nuggets one at a time, by group (topic, lecture, exercise week, …), or search them.
- Every nugget shows its links: *assumes you know*, *uses*, *read more*, *natural next topics*, and the computed back-links (*used by*, *prerequisite for*, *mentioned in*).
- Mark a nugget as **I understand this**, **I want to go back to this** or **I need to know more about this**, and write private notes on it.
- Compose several nuggets into one page (“+ compose”), and save compositions as named collections.
- **My notes** collects all statuses, notes and collections. Everything lives in the browser (`localStorage`); an **export link** carries it (compressed, in the URL fragment) to another browser or device.
- In exercises, sections headed `## Answer`, `## Solution` or `## Hint` are folded away until clicked.
- Math is written in LaTeX between `$…$` / `$$…$$` and rendered with KaTeX.

## Instance layout

```
my-course/
  site.md               title and front-page text
  nuggets/**/*.md       one nugget per file (sub-folders are only for your convenience)
  groups/**/*.md        one file per group (optional, but gives titles, order and an intro)
  assets/               images, code, … referenced as assets/<file>
```

### A nugget

```markdown
---
title: Euclid's lemma
kind: theorem                      # definition | theorem | proof | example | exercise | method | puzzle | remark | note
groups: [topics/number-theory]     # any number of groups
requires: [primes, pulverizer]     # knowledge this nugget assumes
uses: [case-splitting]             # results/methods used in it
see-also: [fundamental-theorem-of-arithmetic]   # "read more"
next: [rsa]                        # natural next topics
---
**Lemma.** If $p$ is prime and $p \mid ab$, then $p \mid a$ or $p \mid b$.

Inline references to other nuggets: [[pulverizer]] or [[pulverizer|custom link text]].

## Answer
(in exercises: folded until the reader clicks)
```

The id of a nugget is its file name without `.md` (or an explicit `id:` field). Ids must be unique across the whole instance. The front matter is a small YAML subset: `key: value` and `key: [a, b, c]`.

### A group

The group id is the file path below `groups/` without `.md`, e.g. `groups/lectures/05-induction.md` has id `lectures/05-induction`. The part before the first `/` becomes a section on the front page.

```markdown
---
title: "Lecture: Induction"
rank: 205                          # order of groups on the front page
order: [simple-induction, sum-1-to-n, how-to-write-induction-proofs]
---
Optional introduction, in Markdown.
```

Nuggets listed in `order` automatically become members of the group, so lecture paths can be defined without touching the nuggets. Other members (nuggets that list the group in their `groups:`) follow, alphabetically.

### site.md

```markdown
---
id: my-course            # key for the students' local storage; keep it stable
title: My Course
subtitle: one line
edit-url: https://github.com/me/my-course/edit/main/   # optional: adds an "edit" link to each nugget
---
Front page text.
```

## Building

```
python3 build.py <instance-dir> <output-dir>
```

Only the Python 3 standard library is needed. The build checks that every reference points to an existing nugget and fails otherwise. The output directory is a complete static site: open it through a web server, e.g. `python3 -m http.server -d <output-dir>`, not via `file://`.

The pages load [KaTeX](https://katex.org) 0.16.9 and [marked](https://marked.js.org) 12.0.2 from the jsDelivr CDN.

See `example/` for a minimal instance.
