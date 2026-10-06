# AI policy

Fairbeam is developed with AI coding assistants, and AI-assisted contributions are welcome. This
page says how the project uses AI and what we ask of contributors who do.

## How Fairbeam is made

- **The maintainer directs.** [İsmail Akdağ](https://akdag.dev) maintains Fairbeam and decides
  what is built and what is merged.
- **Much of the work is AI-assisted.** A large part of the code, tests and documentation is written
  with AI coding assistants. Commits written that way carry a `Co-Authored-By:` trailer that names
  the model.
- **Every change is checked before it is merged.** It passes the repository's automated checks
  (`npm run check:*`, the Python test suite) and is reviewed. User-facing changes are also tried
  in the app.
- **Numbers come from runs, not from models.** Results, validation figures and timings in the
  documentation come from simulations that anyone can repeat. A project bundle records the
  generator, the versions and the run settings. A statement by an AI model is never evidence.
- **The maintainer is responsible** for everything in the repository and in the releases,
  whoever or whatever wrote it.

## Contributing with AI assistance

You may use any suitable AI tool or model. If you do:

1. **Say so in the pull request.** Name the tool and the model, and say what it did: wrote the
   code, the tests or the text, or only reviewed or explained. The PR template asks for this.
2. **Test it.** Run the relevant checks and say what you ran and what you saw. For changes to
   physics or numerics, attach a reproducible comparison: a model, its settings, and the result
   before and after.
3. **Keep it focused.** One concern per pull request. Large unreviewed rewrites, mass reformatting
   and drive-by "improvements" generated in bulk will be closed.
4. **Respect licences and data rights.**
   - Fairbeam is GPL-3.0-or-later. Don't submit code that reproduces third-party code under an
     incompatible licence.
   - Don't submit data you have no right to share, such as results exported from licensed
     commercial software, private measurements or other people's designs.
   - Don't paste other people's private information into AI tools.
5. **Check what you post.** Read every issue, comment and review an AI wrote for you before you
   post it. Automated or bulk-generated issues, comments and pull requests will be closed.

Maintainers may close a contribution that doesn't follow these rules, and may ask for changes
before reviewing. Coding agents working in this repository also read [AGENTS.md](AGENTS.md).

## Security

Report security problems privately to the maintainer, not in a public issue. Contact details are at
<https://akdag.dev>.
