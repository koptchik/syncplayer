# Repository Guidelines

## Project Status & Scope

Syncplayer is intended to be a cross-platform player for shared viewing in networked rooms, supporting downloaded videos, YouTube, and Twitch. This repository currently has no application code, dependency manifests, test configuration, or Git history. Treat the structure below as guidance for initial development, not an existing implementation.

## Project Structure & Module Organization

Keep playback adapters, room synchronization, and user interface code in separate modules. When introducing the application, use clearly named directories such as `src/`, `tests/`, and `assets/`, unless the chosen framework requires another layout. Document the actual layout in `README.md`. Keep downloaded media, uploads, generated output, and local configuration out of version control.

## Build, Test, and Development Commands

No build, development, or test commands are configured yet. When selecting the stack, add reproducible setup instructions and document exact commands in `README.md` for installing dependencies, running locally, building, and testing. Do not assume commands such as `npm test` exist before adding the corresponding configuration. Explain how to connect two clients to the same room for local verification.

## Coding Style & Naming Conventions

Follow the selected language's standard conventions and configure its formatter and linter alongside the first implementation. Use consistent indentation within each language. Prefer descriptive names such as `PlaybackState`, `room_id`, or `roomId`, according to language conventions. Keep synchronization logic independent of provider-specific player APIs.

## Testing Guidelines

No testing framework or coverage threshold exists yet. Introduce automated tests for room creation and joining, playback synchronization, reconnection, and invalid media inputs. Name tests after observable behavior and place them under `tests/` or the framework's conventional location. Verify shared playback using two independent browser sessions or clients.

## Commit & Pull Request Guidelines

No existing commit convention can be inferred. Use concise, imperative commit subjects, for example, `Add room invitation links`. Keep each change focused. Pull requests should explain behavior, link relevant issues, list verification performed, and include screenshots for interface changes. State platform limitations and any manual checks still required.
