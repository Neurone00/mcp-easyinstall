# Changelog

What changed in each release of Moskito Easy MCP, newest first.

## 2.59.0 · 6 Nov 2026
- Adobe panels: when a panel isn't connected, the Connect button and "connect automatically" sit at the top, instead of inside the More menu.

## 2.58.0 · 4 Nov 2026
- Premiere and Media Encoder: After Effects comps no longer go offline. The hidden After Effects that Premiere uses to show them crashed every ten seconds, because the script that opens our panel at launch also ran in there. It now stays out.

## 2.57.0 · 30 Oct 2026
- Updates now install on Macs where the person isn't an admin. Before, the update banner kept coming back and the app never updated.
- If an update still can't install, the Mac stops offering it and the failure shows on the usage page.
- Download page: the Adobe apps sit under the tagline, and the small print is easier to read.

## 2.56.0 · 29 Oct 2026
- Italian interface on Macs set to Italian (control panel, menu bar, help). The Adobe panels follow the Adobe app's language.
- Photoshop: creating a new document works on Italian Photoshop, and uses the name asked for.
- Reinstalling keeps the Mac's usage id, so it isn't counted as a new Mac.

## 2.55.0 · 29 Oct 2026
- Updates install by themselves after an hour without use, or at the next launch. The menu bar shows "Update to x.y.z" while one is waiting.
- Starts at login.
- Setup opens nothing on its own, restarts the assistants the first time, and asks about ChatGPT up front.
- Claude Code is told apart from the Claude app in the usage figures.
- Usage page: people listed by Mac name, a failure log, a period filter, and a sign-in.
- Uninstall also quits the menu bar app.

## 2.54.0 · 29 Oct 2026
- InDesign is back.
- New double-click installer (.pkg) that installs and runs setup by itself.
- Illustrator and After Effects open their panel by themselves at launch. Photoshop, Premiere and InDesign panels connect by default.
- Uninstall from the menu bar removes everything the app added.
- The setup screen keeps the reason setup didn't finish next to the button.

## 2.53.0 · 27 Oct 2026
- Uses its own Python, never the Mac's.
- Checks Claude and ChatGPT are installed, and offers the download if not.
- Photoshop and Premiere: loads the panel when a request needs it.
- Download page: install and usage guides behind two buttons.

## 2.52.0 · 26 Oct 2026
- Premiere: a single title in the timeline no longer breaks every command.

## 2.51.0 · 26 Oct 2026
- Premiere can now trim, apply effects and colour, keyframe and add titles through a general-purpose script tool.
- Claude no longer takes over the Mac to work in Premiere.

## 2.50.0 · 19 Oct 2026
- Claude is told to stay on these tools and never operate the Adobe apps by clicking around the screen.

## 2.49.0 · 19 Oct 2026
- Scripts that failed inside an Adobe app are now counted as failures.
- Counts are no longer lost when the app quits.

## 2.48.0 · 8 Oct 2026
- Sends people to Adobe's own page to download the UXP Developer Tool.

## 2.47.0 · 8 Oct 2026
- Fixed the dead UXP Developer Tool link; setup opens it in one step.
- Download page says which version you're getting and links all versions.

## 2.46.0 · 8 Oct 2026
- An update can be pushed to everyone at once from the usage page.

## 2.45.0 · 8 Oct 2026
- Checks for updates hourly instead of every six hours.

## 2.44.0 · 8 Oct 2026
- Fixed Illustrator and After Effects not working at all since 2.41.0.

## 2.43.0 · 7 Oct 2026
- "Set everything up" now really does set everything up.

## 2.42.0 · 7 Oct 2026
- The first run shows just the one setup button.

## 2.41.0 · 7 Oct 2026
- Usage figures say which assistant was used.
- Stopped sending the macOS version.
