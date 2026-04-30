#!/bin/bash
# Fixes commits that have lost their committer information.
# This can happen when SourceTree modifies the git index in a colocated jj repo.

REVSET='committer_name("") ~ root() & mutable()'

COMMITS=$(jj log -r "$REVSET" --no-graph --template 'change_id.short() ++ "\n"' 2>/dev/null)

if [ -z "$COMMITS" ]; then
    echo "No commits with missing committer found."
    exit 0
fi

echo "Commits with missing committer:"
jj log -r "$REVSET" --no-graph --template 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'
echo ""

jj metaedit --force-rewrite -r "$REVSET"
echo "Committer information has been updated."
