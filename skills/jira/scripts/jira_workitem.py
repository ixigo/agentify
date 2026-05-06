#!/usr/bin/env python3
"""Build or run common `acli jira workitem` commands."""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys


ASSIGNED_JQL = (
    "assignee = currentUser() AND statusCategory != Done "
    "ORDER BY priority DESC, updated DESC"
)


def base_command(args: list[str]) -> list[str]:
    return ["acli", "jira", "workitem", *args]


def print_or_run(command: list[str], run: bool) -> int:
    if command[0] == "__print__":
        print(command[1])
        return 0
    printable = shlex.join(command)
    print(printable)
    if not run:
        return 0
    return subprocess.run(command, check=False).returncode


def add_run(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--run", action="store_true", help="execute the command")


def command_create(args: argparse.Namespace) -> list[str]:
    command = base_command(
        [
            "create",
            "--summary",
            args.summary,
            "--project",
            args.project,
            "--type",
            args.type,
        ]
    )
    if args.assignee:
        command.extend(["--assignee", args.assignee])
    if args.label:
        command.extend(["--label", args.label])
    return command


def command_edit(args: argparse.Namespace) -> list[str]:
    command = base_command(["edit", "--key", args.key])
    for flag in ("summary", "description", "assignee", "label"):
        value = getattr(args, flag)
        if value:
            command.extend([f"--{flag}", value])
    if args.yes:
        command.append("--yes")
    return command


def command_transition(args: argparse.Namespace) -> list[str]:
    command = base_command(["transition", "--key", args.key, "--status", args.status])
    if args.yes:
        command.append("--yes")
    return command


def command_assigned_jql(_: argparse.Namespace) -> list[str]:
    return ["__print__", ASSIGNED_JQL]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="build a create command")
    create.add_argument("--summary", required=True)
    create.add_argument("--project", required=True)
    create.add_argument("--type", required=True)
    create.add_argument("--assignee")
    create.add_argument("--label", help="comma-separated labels, if supported by acli")
    add_run(create)
    create.set_defaults(builder=command_create)

    edit = subparsers.add_parser("edit", help="build a key-scoped edit command")
    edit.add_argument("--key", required=True)
    edit.add_argument("--summary")
    edit.add_argument("--description")
    edit.add_argument("--assignee")
    edit.add_argument("--label", help="comma-separated labels, if supported by acli")
    edit.add_argument("--yes", action="store_true")
    add_run(edit)
    edit.set_defaults(builder=command_edit)

    transition = subparsers.add_parser(
        "transition", help="build a key-scoped transition command"
    )
    transition.add_argument("--key", required=True)
    transition.add_argument("--status", required=True)
    transition.add_argument("--yes", action="store_true")
    add_run(transition)
    transition.set_defaults(builder=command_transition)

    assigned = subparsers.add_parser("assigned-jql", help="print assigned-open-work JQL")
    assigned.set_defaults(builder=command_assigned_jql)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return print_or_run(args.builder(args), getattr(args, "run", False))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
