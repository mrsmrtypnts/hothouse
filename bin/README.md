# bin

## Video tools

Convenience wrappers around `ffmpeg`/`ffprobe`. Each takes `-h` for full usage.

### Transforms

Each writes a new video next to the input; the input is never modified.

| Script | What it does |
|---|---|
| `boomerang` | Plays the clip forward then backward. `--audio reverse\|forward\|none`. |
| `crop-black-margin` | Detects and crops black bars (letterbox/pillarbox). |
| `duopanel` | Turns a portrait (or narrower-than-16:9) clip into a 16:9 composite: the original on the right, a scaled crop of it filling the left. |
| `faro` | Slices the timeline into N segments and riffles them like a faro shuffle. Accepts multiple inputs (concatenated) or stdin. |
| `panels` | 1-, 2- or 3-panel side-by-side canon, each panel offset in time. `1panel`, `2panel` and `3panel` are symlinks that set the panel count. |
| `retime` | Stretches or squeezes to an exact duration, preserving audio pitch. Accepts multiple inputs (concatenated, then retimed). |

### Library maintenance

| Script | What it does |
|---|---|
| `convert-to-mp4` | Walks a directory and converts other video formats to `.mp4`, remuxing where possible and re-encoding codecs iMovie can't open. Originals go to a sibling `orig/` directory. `--dry-run` to preview. |
| `mp4-survey` | Reports which directories have the most pending `convert-to-mp4` work, by size. |
| `orig-usage` | Reports which `orig/` directories use the most disk space, i.e. what deleting them would reclaim. |
| `find-portrait-videos` | Lists `.mp4` files under a directory whose height exceeds their width. |

### Naming

Transforms get a short verb or noun (`retime`, `faro`); inspectors and maintenance tools get a descriptive name (`mp4-survey`, `find-portrait-videos`).
