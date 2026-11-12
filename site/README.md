# gnomonharness.com

The source of <https://gnomonharness.com/>: one static page and the files
served beside it. No build step.

| File | What it is |
|---|---|
| `index.html` | The page. Fonts from Google Fonts; everything else inline. |
| `llms.txt` | The site's summary for language models (longer than the repository's own `llms.txt`). |
| `robots.txt` | Allows everything; points at the sitemap. |
| `sitemap.xml` | The page and `llms.txt`. Update `<lastmod>` when either changes. |

## Deploy (Netlify)

- **Publish directory:** `site/`
- **Build command:** none (leave empty)
- **Base directory:** the repository root

Netlify injects its own `/.netlify/scripts/...` tag at serve time; it is not
part of this source and should not be copied back into `index.html`.

Not in this directory, and so not deployed from it:

- **The whitepaper PDF.** The v0.3.2 edition (`whitepaper/gnomon-whitepaper-v0.3.2-{light,dark}.pdf`
  on the live site) is withdrawn: it carries November 2026 peer comparisons
  the site no longer cites. Regenerating it for v0.5.0 is deferred; when it
  exists, add it under `site/whitepaper/` and link it from §12 and the hero.
- **`docs/GUIDE.md`.** The live site served an old copy at `/docs/GUIDE.md`;
  the page now links to the guide on GitHub instead, so it cannot go stale.
  After deploying from `site/`, `/docs/GUIDE.md` and `/whitepaper/*` return
  404, which is intended.

## Content policy

The page follows the repository's benchmark policy for v0.5.0:

- gnomon's own results only for November 2026 onwards; no new peer numbers;
- comparisons with other harnesses only where they were published before
  2026-11-08, each with its date (the 2026-09-02 tie, 50.0% vs 47.1%; context
  on the wire, 4.66×, 2026-09-05);
- no links to `bench/*` branches of the public repository;
- the test count is the `<!-- TESTCOUNT -->` marker in the hero status line and
  in `llms.txt`, filled in from the release-candidate run.

## Accessibility

- A "Skip to content" link is the first focusable element and targets
  `<main id="main">`.
- Open Graph and Twitter card tags are in `<head>`; there is no preview image
  yet (`twitter:card` is `summary`).
- Text colour tokens, WCAG 2.x contrast ratio against each surface the page
  uses (computed, 2026-11-12):

| text token | `--paper` #FAFAF6 | `--bg` #F4F1EA | `--code-bg` #EBE7DE | `--accent-soft` #EDE0D4 | `#fff` |
|---|---|---|---|---|---|
| `--text` #171717 | 17.13 | 15.89 | 14.53 | 13.84 | 17.93 |
| `--muted` #5C5C58 | 6.42 | 5.95 | 5.44 | 5.19 | 6.72 |
| `--accent` #A83B0B | 6.09 | 5.65 | 5.16 | 4.92 | 6.37 |
| `--sketch` #6B655C | 5.51 | 5.11 | 4.67 | 4.45 | 5.77 |

`--accent` was `#C1440E` (3.95:1 on `--accent-soft`, 4.15:1 on `--code-bg`)
and `--sketch` was `#7A746A` (4.43:1 on `--paper`); both were darkened, and the
hard-coded copies of the old accent in inline SVG were replaced with it.
`--sketch` colours only the hero figure, which sits on white or `--paper`.
`--diagram-stroke` (#9A9488) and `--rule` are used for lines and borders only,
never for text.
