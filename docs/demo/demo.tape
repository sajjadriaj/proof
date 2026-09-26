# Renders docs/demo.gif from a real run: `vhs docs/demo/demo.tape` from the repo root.
# Needs vhs, ttyd, ffmpeg and the JetBrains Mono font installed.
Output docs/demo.gif

Set Shell bash
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set LineHeight 1.35
Set Width 1200
Set Height 1000
Set Padding 28
Set Margin 24
Set MarginFill "#1e1e2e"
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 10
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# Work on a copy so the recording can fix the bug without touching the fixture.
Hide
Type "export PS1='\[\e[38;5;150m\]$\[\e[0m\] ' PROOF=$PWD/bin/proof.js && cd $(mktemp -d) && cp -r $OLDPWD/docs/demo/app/. . && proof() { node $PROOF $@; } && clear"
Enter
Sleep 500ms
Show

Type "proof check"
Sleep 400ms
Enter
Sleep 6s

Type "sed -i 's/, stack: err.stack//' server.mjs   # stop leaking the stack trace"
Sleep 400ms
Enter
Sleep 1.5s
Hide
Ctrl+L
Show
Type "proof check"
Sleep 400ms
Enter
Sleep 7s
