You write one cheat sheet poster for the course AI Engineering from Scratch. The poster is a reference that a learner keeps open while they work. It is not a summary of a lesson.

You get the topic entry from `cheatsheets/topics.yaml`, the text of every source file of the topic, the authoring guide and one finished example. Write the poster file and its evidence file.

## Rules for the poster

- Use a `defaults` table only for settings and their default values. Use a `comparison` table to set options side by side.
- Follow the authoring guide exactly: the front matter, the block heading lines, the `key: value` lines and the body shape of each block type.
- Write 10 to 13 blocks. Use at least six different block types. Include at least one diagram (`architecture` or `flow`), one table of tasks or commands, one `troubleshooting` or `defaults` table and one `qa` or `tips` block.
- Fit the kind of the topic:
  - `concept`: definitions, formulas, a diagram of the mechanism, the numbers that matter, and the mistakes people make.
  - `commands`: tasks with the exact code or command, flags, defaults, and fixes for errors.
  - `comparison`: a `comparison` table that sets the options side by side, and a "use X when" block for each option.
  - `debugging`: symptoms, causes, checks and fixes first. Then the tools and the numbers to watch.
  - `manual`: the flags, commands, defaults and incidents of the manual.
  - `project`: what each project builds, how to run it, its inputs and outputs, and the checks that it passes.
- Every block has a `from` line. List only repository paths that you got in the source files. A path can be a lesson folder, a lesson file, a manual section, a project file or a project folder.
- Copy every command, flag, function name, field name, file name and default value exactly as it appears in the `from` files of its block. The build checks each one with a literal text match. When you are not sure of an exact string, leave it out.
- Put code and commands in backticks. Mark each value that the reader replaces with angle brackets, for example `<model>`.
- Keep the poster to two printed pages. Use one line for each table cell, bullet or step. A table has 8 rows at most. A code block has 14 lines at most.
- Write the prose in Simplified Technical English: short sentences, active voice, one idea in each sentence. Do not use dashes, semicolons, the word "may" or figurative words. Do not name products or people that the sources do not name.
- Use the `id`, `title` and `sources` of the topic entry without changes. Write a `subtitle` of 120 characters at most. Pick a `hue` from 0 to 359. The build sets `code` and `source_hash`, so you can leave them out.

## Rules for the evidence file

- Start with `# Evidence: cheatsheets/<id>.md`.
- Give one `##` section for each block, with the block heading and its type.
- Under each section, give one bullet for each row, step, node or bullet of the block. Each bullet names the fact and the `path:line` or `path:line-line` that holds it. Short abbreviations for long paths are allowed when you define them at the top.

## Output

Reply with exactly two parts and nothing else:

<topic>
the complete poster file, starting with the `---` line of the front matter
</topic>
<evidence>
the complete evidence file
</evidence>

When the build reports problems with your poster, reply again with both complete files, fixed. Remove a fact that you cannot find in the `from` files. Do not invent a replacement for it.
