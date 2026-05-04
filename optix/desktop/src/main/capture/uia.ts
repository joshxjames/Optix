import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type UiaElement = {
  name: string;
  helpText: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number };
};

// Doubled from 5s — modern Electron-based apps (VS Code, Slack, Teams) and
// browsers with many tabs can blow past the node cap before completing,
// and 5s left no headroom for the PowerShell child to spin up + load
// UIAutomationClient on cold cache. 8s preserves the doubling pattern.
const UIA_TIMEOUT_MS = 8000;
const UIA_NODE_CAP = 5000;

// Script for walking the window directly under a screen point. Used by
// click-snap so we get the UIA tree of the window the click would land
// on, regardless of which app currently holds OS foreground. Avoids the
// "largest visible window" heuristic in PS_SCRIPT picking the wrong app
// (e.g. Claude desktop while the user is on Chrome).
const PS_SCRIPT_AT_POINT = `
param([int]$X = 0, [int]$Y = 0)
[Console]::Error.WriteLine("uia-at script entered (X=$X Y=$Y)")
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop

  if (-not ('OptixNS.WFP' -as [type])) {
    Add-Type -Namespace OptixNS -Name 'WFP' -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr WindowFromPoint(POINT Point);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetAncestor(System.IntPtr hwnd, uint flags);
'@
  }
  [Console]::Error.WriteLine("uia-at win32 loaded")

  $pt = New-Object OptixNS.WFP+POINT
  $pt.X = $X
  $pt.Y = $Y
  $hwndAtPt = [OptixNS.WFP]::WindowFromPoint($pt)
  if ($hwndAtPt -eq [System.IntPtr]::Zero) {
    [Console]::Error.WriteLine('uia-at: no window at point')
    '[]' | Write-Output
    exit 0
  }
  # GA_ROOT = 2 — promote any child HWND to its top-level ancestor so
  # we walk the full app tree, not just one control's subtree.
  $top = [OptixNS.WFP]::GetAncestor($hwndAtPt, 2)
  $useHwnd = if ($top -ne [System.IntPtr]::Zero) { $top } else { $hwndAtPt }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($useHwnd)
  if ($null -eq $root) {
    [Console]::Error.WriteLine('uia-at: FromHandle null')
    '[]' | Write-Output
    exit 0
  }
  $rootName = ''
  try { $rootName = [string]$root.Current.Name } catch {}
  [Console]::Error.WriteLine('uia-at walking: ' + $rootName)

  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $queue.Enqueue($root)

  $out = [System.Collections.Generic.List[object]]::new()
  $maxNodes = 5000
  $visited = 0

  while ($queue.Count -gt 0 -and $visited -lt $maxNodes) {
    $el = $queue.Dequeue()
    $visited++
    try {
      $rect = $el.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        $name = ''
        $help = ''
        $ctrl = ''
        try { $name = [string]$el.Current.Name } catch {}
        try { $help = [string]$el.Current.HelpText } catch {}
        try { $ctrl = [string]$el.Current.ControlType.ProgrammaticName } catch {}
        $out.Add([pscustomobject]@{
          name = $name
          helpText = $help
          controlType = $ctrl
          x = [int][math]::Round($rect.X)
          y = [int][math]::Round($rect.Y)
          width = [int][math]::Round($rect.Width)
          height = [int][math]::Round($rect.Height)
        })
      }
    } catch {}

    try {
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }

  if ($out.Count -eq 0) { '[]' | Write-Output }
  else { $out | ConvertTo-Json -Compress -Depth 4 | Write-Output }
} catch {
  [Console]::Error.WriteLine('uia-at error: ' + $_.Exception.Message)
  '[]' | Write-Output
  exit 0
}
`;

// PowerShell script piped to powershell.exe via stdin. Walks the foreground
// window's UI Automation tree (BFS via ControlViewWalker) and emits a JSON
// array of {name, helpText, controlType, x, y, width, height}. Coordinates
// are screen pixels.
//
// Notes on escaping: this is a JS *single-quoted* template — no $ or backtick
// interpolation. Inside the script we use PowerShell single-quoted strings
// for literals so $foo isn't interpreted as a PS variable when we don't want
// it to be.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('uia start')
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  [Console]::Error.WriteLine('uia assemblies-loaded')

  # Minimal P/Invoke for GetForegroundWindow only — using -MemberDefinition
  # which is the simple, well-understood path. Get-Process gives us
  # everything else (window title, handle, visibility implicit).
  if (-not ('OptixWin' -as [type])) {
    Add-Type -Namespace OptixNS -Name 'OptixWin' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
'@
  }
  [Console]::Error.WriteLine('uia win32 loaded')

  $useHwnd = [System.IntPtr]::Zero

  # Try foreground first.
  $fg = [OptixNS.OptixWin]::GetForegroundWindow()
  if ($fg -ne [System.IntPtr]::Zero) {
    $fgRoot = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
    if ($null -ne $fgRoot) {
      $fgName = ''
      try { $fgName = [string]$fgRoot.Current.Name } catch {}
      [Console]::Error.WriteLine('uia fg name=[' + $fgName + ']')
      if ($fgName -notmatch 'Optix' -and $fgName -ne '') {
        $useHwnd = $fg
      }
    }
  }

  # Fall back to Get-Process. We need to weed out system overlays / UWP
  # shell stuff (NVIDIA overlay, Settings, TextInputHost, etc.) — they're
  # technically visible "windows" with non-zero area but aren't what the
  # user is actually looking at. After the blacklist, pick the largest
  # remaining window by UIA bounding rectangle.
  if ($useHwnd -eq [System.IntPtr]::Zero) {
    [Console]::Error.WriteLine('uia enumerating processes')
    # Process names of windows we never want to walk — Windows shell, OEM
    # overlays, IMEs, search/start UI, lock screen.
    $blacklist = @(
      'ApplicationFrameHost', 'SystemSettings', 'TextInputHost',
      'NVIDIA Share', 'NVIDIA GeForce Overlay', 'NVIDIA Overlay',
      'ShellExperienceHost', 'StartMenuExperienceHost', 'SearchHost',
      'SearchUI', 'LockApp', 'Cortana', 'WidgetService', 'dwm',
      'explorer', 'TabTip'
    )
    $procs = @(Get-Process | Where-Object {
      $_.MainWindowHandle -ne [System.IntPtr]::Zero -and
      $_.MainWindowTitle -ne '' -and
      $_.MainWindowTitle -notmatch 'Optix' -and
      $blacklist -notcontains $_.ProcessName
    })
    [Console]::Error.WriteLine('uia process candidates=' + $procs.Count)
    $bestHwnd = [System.IntPtr]::Zero
    $bestArea = 0
    $bestTitle = ''
    foreach ($p in $procs) {
      try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
        if ($null -eq $el) { continue }
        $offscreen = $false
        try { $offscreen = [bool]$el.Current.IsOffscreen } catch {}
        $rect = $null
        try { $rect = $el.Current.BoundingRectangle } catch {}
        if ($null -eq $rect) { continue }
        $w = [int]([math]::Round($rect.Width))
        $h = [int]([math]::Round($rect.Height))
        $area = $w * $h
        [Console]::Error.WriteLine('uia proc: ' + $p.ProcessName + ' / ' + $p.MainWindowTitle + ' area=' + $area + ' off=' + $offscreen)
        if ($offscreen) { continue }
        if ($w -lt 200 -or $h -lt 200) { continue }
        if ($area -gt $bestArea) {
          $bestHwnd = $p.MainWindowHandle
          $bestArea = $area
          $bestTitle = $p.MainWindowTitle
        }
      } catch {
        [Console]::Error.WriteLine('uia proc-error: ' + $p.MainWindowTitle + ' / ' + $_.Exception.Message)
      }
    }
    if ($bestHwnd -ne [System.IntPtr]::Zero) {
      $useHwnd = $bestHwnd
      [Console]::Error.WriteLine('uia chose: ' + $bestTitle + ' area=' + $bestArea)
    }
  }

  if ($useHwnd -eq [System.IntPtr]::Zero) {
    [Console]::Error.WriteLine('uia gave up — no usable window')
    '[]' | Write-Output
    exit 0
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($useHwnd)
  if ($null -eq $root) {
    [Console]::Error.WriteLine('uia FromHandle returned null')
    '[]' | Write-Output
    exit 0
  }
  $rootName = ''
  try { $rootName = [string]$root.Current.Name } catch {}
  [Console]::Error.WriteLine('uia walking: ' + $rootName)

  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
  $queue.Enqueue($root)

  $out = [System.Collections.Generic.List[object]]::new()
  # Hard cap on nodes visited so a runaway tree can't hang the process.
  $maxNodes = 5000
  $visited = 0

  while ($queue.Count -gt 0 -and $visited -lt $maxNodes) {
    $el = $queue.Dequeue()
    $visited++
    try {
      $rect = $el.Current.BoundingRectangle
      if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
        $name = ''
        $help = ''
        $ctrl = ''
        try { $name = [string]$el.Current.Name } catch {}
        try { $help = [string]$el.Current.HelpText } catch {}
        try { $ctrl = [string]$el.Current.ControlType.ProgrammaticName } catch {}
        $out.Add([pscustomobject]@{
          name = $name
          helpText = $help
          controlType = $ctrl
          x = [int][math]::Round($rect.X)
          y = [int][math]::Round($rect.Y)
          width = [int][math]::Round($rect.Width)
          height = [int][math]::Round($rect.Height)
        })
      }
    } catch {}

    try {
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) {
        $queue.Enqueue($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch {}
  }

  if ($out.Count -eq 0) { '[]' | Write-Output }
  else { $out | ConvertTo-Json -Compress -Depth 4 | Write-Output }
} catch {
  # Surface the failure to stderr so the Node side can log it. Without this,
  # silent compilation/runtime errors look identical to a successful 0-element
  # walk, hiding bugs.
  [Console]::Error.WriteLine('uia error: ' + $_.Exception.Message)
  '[]' | Write-Output
  exit 0
}
`;

/**
 * Enumerate UI Automation elements for the foreground window. Returns []
 * on non-Windows, on timeout, on PS spawn failure, or on JSON parse error
 * — UIA snap is purely a precision boost and should never block the
 * pipeline.
 *
 * Each returned element has screen-pixel bounds. Coordinate translation
 * to screenshot space is the caller's responsibility (see snap-to-uia).
 */
/**
 * Walk the UIA tree of the window directly under (x, y) on screen. Used
 * by click-snap so the elements we consider are guaranteed to be in the
 * window the click would actually hit — bypasses the foreground / largest-
 * window heuristic in `getUiaElements()` which can pick the wrong app
 * when foreground is briefly empty.
 */
export async function getUiaElementsAtPoint(
  x: number,
  y: number,
): Promise<UiaElement[]> {
  if (process.platform !== 'win32') return [];
  const t0 = performance.now();
  return new Promise<UiaElement[]>((resolve) => {
    let settled = false;
    const finish = (val: UiaElement[]): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const scriptPath = join(tmpdir(), 'optix-uia-at.ps1');
    try {
      writeFileSync(scriptPath, '\uFEFF' + PS_SCRIPT_AT_POINT, { encoding: 'utf8' });
    } catch {
      finish([]);
      return;
    }
    let proc: ReturnType<typeof spawn>;
    try {
      // Pass coords as PowerShell named parameters — explicit, easier to
      // debug, and immune to env-var-not-set silent failures.
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-X',
          String(Math.round(x)),
          '-Y',
          String(Math.round(y)),
        ],
        { windowsHide: true },
      );
    } catch {
      finish([]);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* best-effort */ }
      console.warn('[optix-timing] uia-at timed out');
      finish([]);
    }, UIA_TIMEOUT_MS);
    proc.on('error', () => { clearTimeout(timer); finish([]); });
    proc.on('close', () => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      const trimmed = stdout.trim();
      if (stderr.trim().length > 0) {
        for (const line of stderr.trim().split(/\r?\n/)) {
          if (line.length > 0) console.log(`[optix-timing] uia-at stderr: ${line}`);
        }
      }
      if (trimmed.length === 0) {
        console.log(`[optix-timing] uia-at elements=0 ms=${ms}`);
        finish([]);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        console.warn('[optix-timing] uia-at parse failed');
        finish([]);
        return;
      }
      const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const elements: UiaElement[] = [];
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name : '';
        const helpText = typeof r.helpText === 'string' ? r.helpText : '';
        const controlType = typeof r.controlType === 'string' ? r.controlType : '';
        const ex = typeof r.x === 'number' ? r.x : Number(r.x);
        const ey = typeof r.y === 'number' ? r.y : Number(r.y);
        const ew = typeof r.width === 'number' ? r.width : Number(r.width);
        const eh = typeof r.height === 'number' ? r.height : Number(r.height);
        if (![ex, ey, ew, eh].every((v) => Number.isFinite(v))) continue;
        elements.push({
          name,
          helpText,
          controlType,
          bounds: { x: ex, y: ey, width: ew, height: eh },
        });
      }
      console.log(`[optix-timing] uia-at elements=${elements.length} ms=${ms}`);
      finish(elements);
    });
  });
}

export async function getUiaElements(): Promise<UiaElement[]> {
  if (process.platform !== 'win32') return [];

  const t0 = performance.now();

  return new Promise<UiaElement[]>((resolve) => {
    let settled = false;
    const finish = (val: UiaElement[]): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    // Write the script to a temp file once, then run with -File. Piping via
    // stdin had encoding issues that silently truncated execution after the
    // first line. UTF-8 with BOM ensures PowerShell parses it correctly.
    const scriptPath = join(tmpdir(), 'optix-uia.ps1');
    try {
      if (!existsSync(scriptPath)) {
        writeFileSync(scriptPath, '\uFEFF' + PS_SCRIPT, { encoding: 'utf8' });
      } else {
        // Always rewrite — keeps script in sync with code edits during dev.
        writeFileSync(scriptPath, '\uFEFF' + PS_SCRIPT, { encoding: 'utf8' });
      }
    } catch {
      finish([]);
      return;
    }

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
        ],
        { windowsHide: true },
      );
    } catch {
      finish([]);
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Pull the most-useful identifier out of the PS stderr breadcrumbs.
    // The script writes lines like `uia chose: <title>` / `uia walking:
    // <root-name>` / `uia fg name=[<name>]` — any of those is enough to
    // tell the user *which* app is being slow.
    const extractWindowTitle = (s: string): string | null => {
      const m =
        s.match(/uia chose:\s*([^\r\n]+)/) ??
        s.match(/uia walking:\s*([^\r\n]+)/) ??
        s.match(/uia fg name=\[([^\]]*)\]/);
      const t = m?.[1]?.trim();
      return t && t.length > 0 ? t : null;
    };

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // best-effort
      }
      // Surface the foreground app (when we know it) so the user can tell
      // *which* window is blowing past the timeout — otherwise "uia timed
      // out" gives them no actionable signal.
      const title = extractWindowTitle(stderr);
      console.warn(
        `[optix-timing] uia timed out after ${UIA_TIMEOUT_MS}ms${title ? ` (window: ${title})` : ''}`,
      );
      finish([]);
    }, UIA_TIMEOUT_MS);

    proc.on('error', () => {
      clearTimeout(timer);
      finish([]);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      const trimmed = stdout.trim();
      // The PS script writes a `uia target: <title>` line to stderr so we
      // can verify which window we walked. Always surface it (when present)
      // since it's a useful diagnostic regardless of element count.
      if (stderr.trim().length > 0) {
        // Each line of stderr is a diagnostic checkpoint from the PS script;
        // log them all so we can see exactly where the script gave up.
        for (const line of stderr.trim().split(/\r?\n/)) {
          if (line.length > 0) console.log(`[optix-timing] uia stderr: ${line}`);
        }
      }
      if (trimmed.length === 0) {
        console.log(`[optix-timing] uia elements=0 ms=${ms}`);
        finish([]);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        console.warn('[optix-timing] uia parse failed');
        finish([]);
        return;
      }
      // ConvertTo-Json with a single object emits a bare object, not an array.
      const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const elements: UiaElement[] = [];
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name : '';
        const helpText = typeof r.helpText === 'string' ? r.helpText : '';
        const controlType =
          typeof r.controlType === 'string' ? r.controlType : '';
        const x = typeof r.x === 'number' ? r.x : Number(r.x);
        const y = typeof r.y === 'number' ? r.y : Number(r.y);
        const width = typeof r.width === 'number' ? r.width : Number(r.width);
        const height =
          typeof r.height === 'number' ? r.height : Number(r.height);
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height)
        ) {
          continue;
        }
        if (width <= 0 || height <= 0) continue;
        elements.push({
          name,
          helpText,
          controlType,
          bounds: {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          },
        });
      }
      // Node-cap diagnostic: the PS script silently truncates at UIA_NODE_CAP
      // entries, so the parsed JSON length === cap is a strong signal that
      // the app's tree exceeded our budget. Surface the foreground title
      // (when known) so the user can tell which app caused the slowness.
      if (arr.length >= UIA_NODE_CAP) {
        const title = extractWindowTitle(stderr);
        console.warn(
          `[optix-timing] uia node cap (${UIA_NODE_CAP}) hit${title ? ` — window: ${title}` : ''}; tree truncated`,
        );
      }
      console.log(`[optix-timing] uia elements=${elements.length} ms=${ms}`);
      finish(elements);
    });

  });
}
