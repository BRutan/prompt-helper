-- Path: plugins/chrome_first_install.applescript
-- Automate Chrome's own Load unpacked dialog in the already-open Google Chrome.
-- Chrome must remain running and macOS must grant Accessibility and Automation.
-- No window title, fixed screen position, Chromium binary, or debugging port.

on uiName(theElement)
    tell application "System Events"
        try
            set labelText to name of theElement as text
            if labelText is not "missing value" and labelText is not "" then return labelText
        end try
        try
            set labelText to description of theElement as text
            if labelText is not "missing value" then return labelText
        end try
    end tell
    return ""
end uiName

on uiRole(theElement)
    tell application "System Events"
        try
            return (value of attribute "AXRole" of theElement) as text
        end try
    end tell
    return ""
end uiRole

-- Search all Chrome accessibility windows; auxiliary popovers can appear as the
-- front window (e.g. "Recent Download History"), so never cache its title.
on findControl(labelWanted, controlsOnly)
    tell application "System Events"
        tell process "Google Chrome"
            set fallbackItem to missing value
            repeat with chromeWindow in (every window)
                try
                    set descendants to entire contents of chromeWindow
                    repeat with candidate in descendants
                        set labelText to my uiName(candidate)
                        if labelText is labelWanted or labelText contains labelWanted then
                            set roleText to my uiRole(candidate)
                            if roleText is "AXButton" or roleText is "AXCheckBox" or roleText is "AXSwitch" then
                                return candidate
                            end if
                            if fallbackItem is missing value and controlsOnly is false then
                                set fallbackItem to candidate
                            end if
                        end if
                    end repeat
                end try
            end repeat
            return fallbackItem
        end tell
    end tell
end findControl

on waitForControl(labelWanted, controlsOnly, maxSeconds)
    repeat with iteration from 1 to (maxSeconds * 2)
        set target to my findControl(labelWanted, controlsOnly)
        if target is not missing value then return target
        delay 0.5
    end repeat
    return missing value
end waitForControl

on clickControl(target)
    tell application "System Events"
        try
            perform action "AXPress" of target
            return true
        on error
            try
                click target
                return true
            end try
        end try
        -- Chrome sometimes exposes only a nested text label to AX: press a
        -- nearby button/switch ancestor instead of relying on screen coords.
        set ancestor to target
        repeat 4 times
            try
                set ancestor to parent of ancestor
                set roleText to my uiRole(ancestor)
                if roleText is "AXButton" or roleText is "AXCheckBox" or roleText is "AXSwitch" then
                    try
                        perform action "AXPress" of ancestor
                        return true
                    end try
                end if
            on error
                exit repeat
            end try
        end repeat
    end tell
    return false
end clickControl

on readControlValue(target)
    tell application "System Events"
        try
            return (value of target) as text
        end try
        try
            return (value of attribute "AXValue" of target) as text
        end try
    end tell
    return "unknown"
end readControlValue

on loadExtension(folderPath)
    tell application "Google Chrome"
        if (count of windows) is 0 then error "Google Chrome has no open window."
        activate
        -- The foremost Chrome UI may be an auxiliary Downloads window without
        -- tabs. Find a real, existing browser window rather than naming one.
        set browserWindow to missing value
        repeat with aWindow in (every window)
            try
                if (count of tabs of aWindow) > 0 then
                    set browserWindow to aWindow
                    exit repeat
                end if
            end try
        end repeat
        if browserWindow is missing value then error "No Google Chrome browser window with tabs is open."
        set index of browserWindow to 1
        -- Do not replace the user's existing tab.
        tell browserWindow
            make new tab at end of tabs with properties {URL:"chrome://extensions/"}
            set active tab index to (count of tabs)
        end tell
    end tell

    -- Dismiss Chrome popovers such as Recent Download History before querying
    -- its accessibility tree. We do not rely on a specific window name.
    tell application "System Events"
        tell process "Google Chrome"
            key code 53
        end tell
    end tell
    delay 0.75

    set loadButton to my waitForControl("Load unpacked", true, 10)
    if loadButton is missing value then
        set developerToggle to my waitForControl("Developer mode", true, 8)
        if developerToggle is missing value then
            -- Some Chrome versions expose the text label, not the switch, as
            -- the actionable accessibility element.
            set developerToggle to my findControl("Developer mode", false)
        end if
        if developerToggle is missing value then
            error "Cannot access Developer mode in chrome://extensions. Check macOS Accessibility permission for Terminal and enable Chrome Developer mode."
        end if
        set currentValue to my readControlValue(developerToggle)
        if currentValue is "0" or currentValue is "false" or currentValue is "off" or currentValue is "unknown" then
            if not my clickControl(developerToggle) then
                error "Cannot activate Developer mode. Check Chrome and macOS Accessibility settings."
            end if
        end if
        set loadButton to my waitForControl("Load unpacked", true, 10)
    end if
    if loadButton is missing value then
        set loadButton to my waitForControl("Load unpacked", false, 3)
    end if
    if loadButton is missing value then
        error "Developer mode was attempted, but Chrome did not expose Load unpacked."
    end if
    if not my clickControl(loadButton) then error "Unable to press Load unpacked in the Chrome extensions tab."

    -- Chrome's native Open panel uses Cmd+Shift+G to select a folder by path.
    -- The path was copied by the Python entrypoint with pbcopy beforehand.
    delay 1.0
    tell application "System Events"
        tell process "Google Chrome"
            keystroke "g" using {command down, shift down}
            delay 0.5
            keystroke "v" using {command down}
            delay 0.4
            key code 36
            delay 0.8
            key code 36
        end tell
    end tell
    delay 1
    return "Load unpacked submitted: " & folderPath
end loadExtension

on run argv
    if (count of argv) is not 1 then error "Usage: osascript chrome_first_install.applescript /absolute/unpacked/folder"
    set folderPath to item 1 of argv
    if folderPath does not start with "/" then error "Extension folder must be absolute."
    return my loadExtension(folderPath)
end run
