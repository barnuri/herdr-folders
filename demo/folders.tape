# Record: vhs demo/folders.tape  (run from the repo root; see skills/herdr-folders-demo)
Output demo/demo.gif
Set Shell "bash"
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set FontSize 14
Set Width 1440
Set Height 820
Set Framerate 12
Set Theme "Catppuccin Mocha"
Set Padding 10
Set TypingSpeed 60ms

Hide
Type "bash demo/stage.sh > /tmp/hfd.stage.log 2>&1; sleep 20; clear"
Enter
Sleep 50s
Type "bash demo/run.sh"
Enter
Sleep 1500ms
Show

# t≈1..21: the driver collapses, expands, resizes and opens the bulk close menu
Sleep 21s
# t≈21: git popup is open on web-shop
Sleep 2s
Type "j"
Sleep 2s
Type "s"
Sleep 2s
Type "c"
Type "Round prices to cents"
Sleep 1s
Enter
Sleep 3s
Type "P"
Sleep 3s
Type "q"
# t≈38..61: hide, show, restore herdr's sidebar, replace it again, open a project from the Projects tab
Sleep 24s
