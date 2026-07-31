# Breeder inbox

A running backlog of fixes and improvements noticed while using breeder as an
end user. Append one bullet per item, whenever you hit it -- no need to
elaborate, one line is usually enough.

Nothing here gets acted on automatically. Add to it freely; things only get
triaged and implemented when you say so (e.g. "process the inbox").

## Pending

- in the prompt fields, newlines should be respected, preserved, displayed. loras should always be listed last, and always just one per line, inserting newlines between if needed. (bigger than a quick fix: the existing weight-nudge/diff-overlay code splits prompts on commas only, and this wants newlines to be meaningful too, plus an auto-reordering rule -- needs a design pass on exactly when/how re-sorting kicks in before implementing, rather than guessing)
- let's make denoising strength into a slider 0 to 1 with 0.05 increments
- the "read / unread" indicator should not toggle from unread to read if the generation hasn't yet completed. it can't be read until it's complete.
- it looks like newlines in the prompt are saved but not displayed in the prompt text box until the cursor enters it. like, the prompt has newlines in it, and once i click into the box, they become visible i..e. are used to make new lines. but before i click into the box they are not respected in the way the prompt is displayed.

## Done

- let's get rid of the preview image when hovering over a thumbnail. but we should still show the mutation. (thumbnail-grid hover now shows only the mutation caption, no enlarged image; breadcrumb hover unchanged)
- the vertical space between the breadcrumb thumbs and the mutation string should equal the vertical space between the mutation string and the main image. right now the latter is larger. (removed `.mutation-label`'s -8px top margin so both gaps are 20px)
- similar to the "+ New" button, there should be an affordance to import a new starting point using a file picker ui. ("Import..." button added next to "+ New", wired to the existing /api/root/from-image endpoint)
- in the prompt (and negative prompt) inboxes, i should be able to use cmd-option-up and cmd-option-down to change the strength of keywords and loras, like from "foo" to "(foo:1.1)" and so on (implemented, mirroring mutate.py's weight bounds/step)
- in the prompt and negative prompt boxes, color keywords to indicate what has changed relative to parent. white is unchanged, green is added, red is deleted (and so not actually present -- displayed only as a sort of ghost). for weight changes, green is increased and red is decreased. colors are shown initially, but if the user edits the field, they disappear. (implemented as an opaque overlay showing the diff, incl. ghost-removed segments via an LCS-based diff; disappears on first edit rather than trying to keep an editable textarea in sync with ghost text)
- add filtering controls for browser. one filter is to images which have been parents of another image. or grandparents. maybe it's a generalized filter on longest chain of descendants: 0 is never used, 1 is one child, 2 is one grandchild, and so on. another filter might be keywords in image spec (added a filter bar above the thumbnail grid: min descendant-depth dropdown + keyword search over prompt/negative_prompt; filters the grid in place without a full re-render)
- when i make the browser window bigger, what should expand is the main image, the focused image. right now what expands is the prompt text box and the stuff underneath it. keep that fixed and expand the image instead. (`.detail-image` now flex-grows to fill available space, `.detail-form` has a fixed flex-basis instead of flex:1)
- the outline on the selected thumb in the browser needs to be more visible (thicker border in a brighter accent color, plus an outer glow ring)
- it would be cool if there were a visual distinction between "opened" (viewed) and "unopened" (not yet viewed) thumbs, kind of like in an email inbox. so that you can see which thumbs you've already viewed and which you still have yet to look at. not sure of best visual design. (small unread-dot badge on unviewed thumbnails, cleared once you focus that node; tracked in localStorage so it persists across sessions)
- cmd-enter to trigger breeding should work even if i'm not in the text box (the shortcut now fires from anywhere in the detail panel, not just the prompt/negative-prompt fields)
- when i use the arrow keys to navigate in the thumb browser, if i keep going down the selected thumb is no longer visible. the view should scroll down so that the selected thumb is always visible. (scrollIntoView after every render, not just keyboard nav)
- the filter controls have the same problem we've seen with other ui elements in the past: they keep losing focus if generations are in process. (real regression -- the poll-skip guard only checked focus inside .detail-panel, not .browser-panel where the filter inputs live; broadened the check to cover both)
- [URGENT] something went wrong in recent commit. now i can't click in to prompt text boxes at all. (couldn't reproduce the exact symptom -- careful testing showed the diff-overlay's pointer-events:none click-through was actually working. But that design was fragile regardless: if pointer-events ever failed for any reason in some browser/environment, the whole prompt box becomes unusable, which is a bad failure mode for a cosmetic feature. Redesigned so the overlay is itself directly clickable -- dismisses and focuses the real textarea on mousedown -- instead of depending on CSS click-through at all. If this doesn't fix what you were seeing, please add more detail -- browser, exactly which field, whether it's every prompt field or just ones showing the diff overlay.)

## Won't fix

- the slider for reroll prob doesn't go to the ends. if the number is 0%, it's not all the way at the left of the slider. conversely for 100%. it should go to the ends. (native `<input type=range>` behavior -- the thumb is always centered on its value, so it insets by half its own width at each end. Fixing it means dropping `accent-color` theming for a fully custom track/thumb; decided not worth it.)
