# New Tasks 1

1) add delete thread option in chats

2) add rename feature to threads in chat so they can be called something that isnt 'thread <date>'

3) In settings within a site, allow Approvals to be bypassed so I dont have to do it each time

4) we need to do something about the fact its terrible at adding blocks, and keeps adding blocks I tell it not to, and also doesnt quite understand the block setup and structure, keep getting roken blocks with 'attempt recovery'. 

5) build out fixture-backed automated E2E scenarios instead of relying on ad hoc exported request replays. Start with a named media/gallery suite that covers:
- single inline image replay with a concrete saved URL
- multi-image gallery layout with 8 resolved fixture images
- explicit mapping from fixture image assets into Gutenberg image blocks
- verification that preview/editor both render without invalid block recovery
- artifacts that show which fixture images were used and where execution failed if mapping breaks
