# AI policy

Fairbeam is developed with AI coding agents, and AI-assisted contributions are welcome. This page
says how the project itself uses AI and what we ask of contributors who do.

## How Fairbeam is made

- **The maintainer directs.** [İsmail Akdağ](https://akdag.dev) maintains Fairbeam and decides
  what is built and what is merged.
- **Agents do much of the writing.** A large part of the code, tests and documentation is written
  by AI coding agents, mainly Anthropic's Claude through Claude Code; earlier work also used
  OpenAI's Codex. They work on the maintainer's macOS and Windows machines from GitHub issues (see
  [AGENTS.md](AGENTS.md)).
- **Commits say so.** Every agent-written commit carries a `Co-Authored-By:` trailer that names
  the model.
- **Nothing is merged on the agent's word alone.** Each change goes through:
  - the repository's automated checks (`npm run check:*`, the Python test suite);
  - a review by a second agent or by the maintainer;
  - for user-facing changes, a hands-on test in the app on the platform concerned.
- **Numbers come from runs, not from models.** Results, validation figures and timings in the
  documentation come from simulations that anyone can repeat. A project bundle records the
  generator, the versions and the run settings. A statement by an AI model is never evidence.
- **The maintainer is responsible.** The maintainer answers for everything in the repository and in
  the releases, whoever or whatever wrote it.

## Contributing with AI assistance

You may use any AI tool. If you do:

1. **Say so in the pull request.** Name the tool and the model, and say what it did: wrote the
   code, the tests or the text, or only reviewed or explained. The PR template asks for this.
2. **Understand every line.** Be ready to explain and defend each change in review, without asking
   the AI again. Don't submit code you could not have reviewed yourself.
3. **Test it.** Run the relevant checks and say what you ran and what you saw. For changes to
   physics or numerics, attach a reproducible comparison: a model, its settings, and the result
   before and after.
4. **Keep it focused.** One concern per pull request. Large unreviewed rewrites, mass reformatting
   and drive-by "improvements" generated in bulk will be closed.
5. **Respect licences and data rights.**
   - Fairbeam is GPL-3.0-or-later. Don't submit code that reproduces third-party code under an
     incompatible licence.
   - Don't submit data you have no right to share, such as results exported from licensed
     commercial software, private measurements or other people's designs.
   - Don't paste other people's private information into AI tools.
6. **Write issues and reviews yourself**, or check every word of an AI-written one before you post
   it. Automated or bulk-generated issues, comments and pull requests will be closed.

Maintainers may close a contribution that doesn't follow these rules, and may ask for changes
before reviewing. AI agents working in this repository also follow [AGENTS.md](AGENTS.md).

## Security

Report security problems privately to the maintainer, not in a public issue. Contact details are at
<https://akdag.dev>.
