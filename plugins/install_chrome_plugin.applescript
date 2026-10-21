-- Path: plugins/install_chrome_plugin.applescript
-- Load/reload prompt-helper in an already-running, normal Google Chrome window.
-- Uses macOS Accessibility UI scripting (Chrome deliberately has no direct
-- AppleScript command to sideload an unpacked extension into a running window).
-- Requires Automation + Accessibility access for Terminal/osascript.

on getName(anElement)
    tell application "System Events"
        try
            return name of anElement as text
        on error
            return ""
        end try
    end tell
end getName

on getDescription(anElement)
    tell application "System Events"
        try
            return description of anElement as text
        on error
            return ""
        end try
    end tell
end getDescription

on getRole(anElement)
    tell application "System Events"
        try
            return value of attribute "AXRole" of anElement as text
        on error
            return ""
        end try
    end tell
end getRole

on clickable(anElement)
    set elementRole to my getRole(anElement)
    return elementRole is "AXButton" or elementRole is "AXCheckBox" or elementRole is "AXSwitch" or elementRole is "AXToggleButton" or elementRole is "AXRadioButton"
end clickable

on isNamed(anElement, searchTerm)
    return (my getName(anElement) contains searchTerm) or (my getDescription(anElement) contains searchTerm)
end isNamed

on hasElement(windowRef, searchTerm)
    tell application "System Events"
        repeat with anElement in (entire contents of windowRef)
            if my isNamed(anElement, searchTerm) then return true
        end repeat
    end tell
    return false
end hasElement

on clickButton(windowRef, searchTerm)
    tell application "System Events"
        repeat with anElement in (entire contents of windowRef)
            if my clickable(anElement) and my isNamed(anElement, searchTerm) then
                try
                    click anElement
                    return true
                end try
            end if
        end repeat
    end tell
    return false
end clickButton

on waitForButton(windowRef, searchTerm, retries)
    repeat with n from 1 to retries
        if my hasElement(windowRef, searchTerm) then return true
        delay 0.5
    end repeat
    return false
end waitForButton

-- Reload only the card whose title matches the extension. Do not accidentally
-- reload an unrelated extension in the page (the parent search is bounded).
on reloadOwnCard(windowRef, extensionName)
    tell application "System Events"
        repeat with anElement in (entire contents of windowRef)
            if my isNamed(anElement, extensionName) then
                set currentParent to anElement
                repeat with depth from 1 to 6
                    try
                        set currentParent to parent of currentParent
                        set descendants to entire contents of currentParent
                        -- A full-page ancestor is not a safe reload scope.
                        if (count of descendants) > 100 then exit repeat
                        repeat with childElement in descendants
                            if my clickable(childElement) and my isNamed(childElement, "Reload") then
                                try
                                    click childElement
                                    return true
                                end try
                            end if
                        end repeat
                    on error
                        exit repeat
                    end try
                end repeat
            end if
        end repeat
    end tell
    return false
end reloadOwnCard

on pickUnpackedFolder(windowRef, unpackedPath)
    tell application "System Events"
        -- Chrome's native folder chooser: Go to Folder -> choose unpacked dir.
        keystroke "g" using {command down, shift down}
        delay 0.5
        keystroke unpackedPath
        key code 36
        delay 0.8
        -- Confirm the selected directory (Open/Select).
        if not my clickButton(windowRef, "Select") then
            if not my clickButton(windowRef, "Open") then key code 36
        end if
    end tell
end pickUnpackedFolder

on run argv
    if (count of argv) < 2 then error "Usage: osascript install_chrome_plugin.applescript UNPACKED_DIR EXTENSION_NAME"
    set unpackedPath to item 1 of argv
    set extensionName to item 2 of argv
    tell application "System Events"
        if not (exists process "Google Chrome") then error "Google Chrome must already be running; this installer does not start a browser."
    end tell

    -- Add a tab to the existing front window. Never launch Chromium, relaunch
    -- Chrome, change profiles, or replace the original tab.
    tell application "Google Chrome"
        if (count of windows) is 0 then error "Google Chrome is running but has no open browser windows."
        set previousWindowID to id of front window
        set previousTabIndex to active tab index of front window
        tell front window to make new tab at end of tabs with properties {URL:"chrome://extensions/"}
        activate
    end tell
    delay 1.0
    set outcome to ""
    try
        tell application "System Events"
            set windowRef to front window of process "Google Chrome"
        end tell
        -- Prefer a card-scoped reload when the extension is already installed.
        if my hasElement(windowRef, extensionName) then
            if my reloadOwnCard(windowRef, extensionName) then
                set outcome to "RELOADED"
            else
                error "Existing extension found, but its Reload control is not accessible. Reload it manually at chrome://extensions (Developer mode)."
            end if
        else
            if not my waitForButton(windowRef, "Load unpacked", 10) then
                if not my clickButton(windowRef, "Developer mode") then
                    error "Cannot find Chrome's Developer mode toggle. Enable it at chrome://extensions."
                end if
                if not my waitForButton(windowRef, "Load unpacked", 12) then
                    error "Load unpacked did not appear after enabling Developer mode."
                end if
            end if
            if not my clickButton(windowRef, "Load unpacked") then
                error "Could not activate Chrome's Load unpacked button."
            end if
            delay 0.8
            my pickUnpackedFolder(windowRef, unpackedPath)
            set loaded to false
            repeat with attemptNumber from 1 to 16
                delay 0.5
                if my hasElement(windowRef, extensionName) then
                    set loaded to true
                    exit repeat
                end if
            end repeat
            if not loaded then error "Chrome has not shown the extension card. Check the folder chooser or any Chrome error on chrome://extensions."
            set outcome to "LOADED"
        end if
    on error errorMessage number errorNumber
        -- Keep chrome://extensions visible so the user can resolve the issue.
        error "Chrome installation stopped: " & errorMessage number errorNumber
    end try

    -- Return focus to the original tab in the original open Chrome window.
    try
        tell application "Google Chrome"
            set active tab index of window id previousWindowID to previousTabIndex
        end tell
    end try
    return outcome & " prompt-helper in the existing Google Chrome window"
end run
