# Breeder inbox

A running backlog of fixes and improvements noticed while using breeder as an
end user. Append one bullet per item, whenever you hit it -- no need to
elaborate, one line is usually enough.

Nothing here gets acted on automatically. Add to it freely; things only get
triaged and implemented when you say so (e.g. "process the inbox").

## Pending

- the slider for reroll prob doesn't go to the ends. if the number is 0%, it's not all the way at the left of the slider. conversely for 100%. it should go to the ends. (blocked on a product call: this is native `<input type=range>` behavior -- the thumb's center sits inset by half its own width at each end, by design, so making it flush requires replacing `accent-color` styling with a fully custom track/thumb, with real cross-browser quirk risk. Left alone rather than guess at a look you haven't signed off on.)
- in the prompt and negative prompt boxes, color keywords to indicate what has changed relative to parent. white is unchanged, green is added, red is deleted (and so not actually present -- displayed only as a sort of ghost). for weight changes, green is increased and red is decreased. colors are shown initially, but if the user edits the field, they disappear.

## Done

- let's get rid of the preview image when hovering over a thumbnail. but we should still show the mutation. (thumbnail-grid hover now shows only the mutation caption, no enlarged image; breadcrumb hover unchanged)
- the vertical space between the breadcrumb thumbs and the mutation string should equal the vertical space between the mutation string and the main image. right now the latter is larger. (removed `.mutation-label`'s -8px top margin so both gaps are 20px)
- similar to the "+ New" button, there should be an affordance to import a new starting point using a file picker ui. ("Import..." button added next to "+ New", wired to the existing /api/root/from-image endpoint)
- in the prompt (and negative prompt) inboxes, i should be able to use cmd-option-up and cmd-option-down to change the strength of keywords and loras, like from "foo" to "(foo:1.1)" and so on (implemented, mirroring mutate.py's weight bounds/step)
