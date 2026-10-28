# Working agreements

These apply to any coding agent working in this repository. Anything more specific in a
subfolder's own instructions wins over what is written here.

## Before you change anything

- Read the code around the change and the project's own docs first. Match the conventions you
  find instead of bringing your own.
- Find out how the project builds, lints and tests (look at its README, CONTRIBUTING and
  package scripts), and use those commands.
- If the request is ambiguous and a wrong guess would be costly, ask. Otherwise state your
  assumption and carry on.

## While you work

- Keep each change small and focused on what was asked. Mention unrelated problems you notice
  instead of fixing them on the side.
- Do not add dependencies, change configuration or rename public things without a reason you
  can state in one sentence.
- Prefer the simplest design that works. Do not build for needs nobody has.
- Write comments that explain why, not what.
- Never write secrets, tokens or personal data into files, tests, logs or commit messages.
  Read them from the environment.

## Before you say it is done

- Run the project's checks and tests for what you touched, and report failures as they are.
  Never weaken, skip or delete a test to make a change pass.
- A bug fix comes with a test that fails without the fix.
- Re-read your diff as a reviewer would. Remove leftovers such as debug output and dead code.
- Say what you changed, what you ran, and anything you were unsure about or left out.

## Version control

- Do not commit, push or open pull requests unless asked.
- Never rewrite history that has been pushed, and never discard changes you did not make.
- Write commit messages that say why the change was made, not only what it is.
