"""Rugged · commit watcher — poller.

Phase 2. Polls https://api.github.com/repos/iterativv/NostalgiaForInfinity/commits
every 30 seconds (using GITHUB_TOKEN), filters for commits touching the
blacklist file, and passes new diffs to diff_parser.

STUB — implemented in Phase 2 (project.md §"Phase 2: Commit Watcher").
"""
