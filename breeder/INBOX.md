# Breeder inbox

A running backlog of fixes and improvements noticed while using breeder as an
end user. Append one bullet per item, whenever you hit it -- no need to
elaborate, one line is usually enough.

Nothing here gets acted on automatically. Add to it freely; things only get
triaged and implemented when you say so (e.g. "process the inbox").

## Pending

## Done

- let's get rid of the preview image when hovering over a thumbnail. but we should still show the mutation. (thumbnail-grid hover now shows only the mutation caption, no enlarged image; breadcrumb hover unchanged)
- the vertical space between the breadcrumb thumbs and the mutation string should equal the vertical space between the mutation string and the main image. right now the latter is larger. (removed `.mutation-label`'s -8px top margin so both gaps are 20px)
- similar to the "+ New" button, there should be an affordance to import a new starting point using a file picker ui. ("Import..." button added next to "+ New", wired to the existing /api/root/from-image endpoint)
- in the prompt (and negative prompt) inboxes, i should be able to use cmd-option-up and cmd-option-down to change the strength of keywords and loras, like from "foo" to "(foo:1.1)" and so on (implemented, mirroring mutate.py's weight bounds/step)
- in the prompt and negative prompt boxes, color keywords to indicate what has changed relative to parent. white is unchanged, green is added, red is deleted (and so not actually present -- displayed only as a sort of ghost). for weight changes, green is increased and red is decreased. colors are shown initially, but if the user edits the field, they disappear. (implemented as an opaque overlay showing the diff, incl. ghost-removed segments via an LCS-based diff; disappears on first edit rather than trying to keep an editable textarea in sync with ghost text)
- add filtering controls for browser. one filter is to images which have been parents of another image. or grandparents. maybe it's a generalized filter on longest chain of descendants: 0 is never used, 1 is one child, 2 is one grandchild, and so on. another filter might be keywords in image spec (added a filter bar above the thumbnail grid: min descendant-depth dropdown + keyword search over prompt/negative_prompt; filters the grid in place without a full re-render)

## Won't fix

- the slider for reroll prob doesn't go to the ends. if the number is 0%, it's not all the way at the left of the slider. conversely for 100%. it should go to the ends. (native `<input type=range>` behavior -- the thumb is always centered on its value, so it insets by half its own width at each end. Fixing it means dropping `accent-color` theming for a fully custom track/thumb; decided not worth it.)
