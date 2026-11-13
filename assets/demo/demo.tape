# Re-render the README demo:
#   cd "$(assets/demo/setup.sh)" && vhs /path/to/agentify/assets/demo/demo.tape
# Requires vhs (brew install vhs), jq, and agentify on PATH.
Output agentify-demo.gif

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 16
Set Width 1200
Set Height 660
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set WindowBar Colorful

Hide
Type "setopt interactivecomments; export PS1='%F{blue}fare-calc%f %F{green}❯%f ' && clear" Enter
Sleep 500ms
Show

Type "# Session 1: leave the repo some memory" Sleep 600ms Enter
Type "agentify ctx decision 'chose node:test over jest to keep zero deps'" Sleep 300ms Enter
Sleep 1.2s
Type "agentify ctx note 'min fare is a pricing rule, confirm before changing'" Sleep 300ms Enter
Sleep 1.5s

Type "clear" Enter
Type "# New session, any agent: the repo still remembers" Sleep 600ms Enter
Type "agentify ctx load" Sleep 300ms Enter
Sleep 3.5s

Type "clear" Enter
Type "# What does touching fare.js break?" Sleep 600ms Enter
Type "agentify query impacts --file src/fare.js --json | jq -r '.impacts[] | .file_path'" Sleep 300ms Enter
Sleep 3s
Type "agentify risk --since HEAD~1" Sleep 300ms Enter
Sleep 4s

Type "clear" Enter
Type "# Run only the tests this change affects" Sleep 600ms Enter
Type "agentify test --since HEAD~1" Sleep 300ms Enter
Sleep 4.5s
