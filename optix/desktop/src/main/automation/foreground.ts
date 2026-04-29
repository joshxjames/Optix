// Win32 foreground-window manipulation via a long-lived PowerShell child.
//
// Why long-lived: a fresh `powershell.exe` cold-start runs ~1.5–2s, which
// would make focus toggles painfully laggy. We spawn one process at first
// use, send simple line-based commands on stdin, and read line-based
// responses on stdout — round-trips drop to ~10ms once the host is warm.
//
// Why PowerShell at all: we need P/Invoke into `user32.dll` to call
// SetForegroundWindow with the AttachThreadInput trick (Windows blocks bare
// SetForegroundWindow from non-foreground processes). PowerShell + Add-Type
// is the lowest-friction path that avoids adding a native FFI dependency.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const PROTOCOL = `
$ErrorActionPreference = 'Stop'

Add-Type -Namespace OptixFG -Name FG -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool BringWindowToTop(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)]
public static extern int GetWindowText(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowTextLength(System.IntPtr hWnd);
'@

# Loop reading stdin commands. Two commands:
#   GET                 -> emit foreground HWND as decimal int64
#   SET <hwnd-decimal>  -> attempt to make that HWND foreground; emit OK
# After every command we emit a single line, so the JS side can pair
# requests with responses.
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    if ($line -eq 'GET') {
      $hwnd = [OptixFG.FG]::GetForegroundWindow()
      [Console]::Out.WriteLine($hwnd.ToInt64())
    }
    elseif ($line -eq 'TITLE') {
      $hwnd = [OptixFG.FG]::GetForegroundWindow()
      $len = [OptixFG.FG]::GetWindowTextLength($hwnd)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [OptixFG.FG]::GetWindowText($hwnd, $sb, $len + 1) | Out-Null
        # Single-line response — strip embedded newlines defensively
        # via a regex (avoids using PS backtick escapes that conflict
        # with the JS template literal wrapping this script).
        $title = $sb.ToString() -replace '[\\r\\n]+', ' '
        [Console]::Out.WriteLine($title)
      } else {
        [Console]::Out.WriteLine('')
      }
    }
    elseif ($line.StartsWith('SET ')) {
      $val = $line.Substring(4).Trim()
      $hwnd = [System.IntPtr]([System.Int64]$val)

      # AttachThreadInput trick: temporarily share input queue with the
      # current foreground thread so SetForegroundWindow is permitted.
      $proc = 0
      $fThr = [OptixFG.FG]::GetWindowThreadProcessId(
        [OptixFG.FG]::GetForegroundWindow(), [ref]$proc)
      $myThr = [OptixFG.FG]::GetCurrentThreadId()
      [OptixFG.FG]::AttachThreadInput($myThr, $fThr, $true) | Out-Null
      [OptixFG.FG]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
      [OptixFG.FG]::BringWindowToTop($hwnd) | Out-Null
      [OptixFG.FG]::SetForegroundWindow($hwnd) | Out-Null
      [OptixFG.FG]::AttachThreadInput($myThr, $fThr, $false) | Out-Null
      [Console]::Out.WriteLine('OK')
    }
    else {
      [Console]::Out.WriteLine('ERR unknown')
    }
  } catch {
    [Console]::Out.WriteLine("ERR " + $_.Exception.Message)
  }
}
`;

let child: ChildProcessWithoutNullStreams | null = null;
let pendingResolver: ((line: string) => void) | null = null;
let stdoutBuffer = '';

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child && !child.killed) return child;
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'],
    { windowsHide: true },
  );
  proc.stdin.setDefaultEncoding('utf8');
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  proc.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, nl).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      const r = pendingResolver;
      pendingResolver = null;
      r?.(line);
    }
  });

  proc.on('exit', () => {
    child = null;
    pendingResolver?.('ERR ps-exited');
    pendingResolver = null;
    stdoutBuffer = '';
  });

  // Bootstrap the protocol script. From now on the child reads stdin lines.
  proc.stdin.write(PROTOCOL + '\n');

  child = proc;
  return proc;
}

function send(cmd: string, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = ensureChild();
    if (pendingResolver) {
      reject(new Error('Foreground PowerShell is busy.'));
      return;
    }
    const timer = setTimeout(() => {
      pendingResolver = null;
      reject(new Error('Foreground PowerShell timed out.'));
    }, timeoutMs);
    pendingResolver = (line) => {
      clearTimeout(timer);
      resolve(line);
    };
    proc.stdin.write(cmd + '\n');
  });
}

/** Returns the HWND of the currently-foreground window as a decimal string,
 *  or null on failure. The string form is what `setForegroundWindow` expects. */
export async function captureForegroundHwnd(): Promise<string | null> {
  try {
    const out = await send('GET');
    if (out.startsWith('ERR')) return null;
    return out;
  } catch {
    return null;
  }
}

/** Title of the currently-foreground window, or null if unknown.
 *  Used by the routine recorder so each saved action carries the
 *  app context it was performed in (e.g. "File Explorer — hi"). */
export async function getForegroundWindowTitle(): Promise<string | null> {
  try {
    const out = await send('TITLE');
    if (out.startsWith('ERR')) return null;
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Make the given HWND the foreground window. Returns true on success.
 *  The input is bounded to digits-only so a caller can't smuggle
 *  arbitrary text into the line-based protocol (which uses spaces +
 *  the prefix `SET` to dispatch). Defence-in-depth: nobody currently
 *  passes attacker-controlled HWNDs, but the validation is cheap and
 *  the cost of a bad-line injection would be a stuck PowerShell. */
export async function setForegroundWindow(hwndDecimal: string): Promise<boolean> {
  if (!/^[0-9]+$/.test(hwndDecimal)) return false;
  try {
    const out = await send(`SET ${hwndDecimal}`);
    return out === 'OK';
  } catch {
    return false;
  }
}
