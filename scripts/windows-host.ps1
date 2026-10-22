param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Job', 'Daemon', 'Console', 'PipeAcl', 'PipeLock', 'Acl', 'Compile')]
  [string]$Mode,
  [string]$Payload,
  [string]$Pipe,
  [string]$Log,
  [string]$Out
)

$ErrorActionPreference = 'Stop'

# Acl (the daemon, before it writes anything, B8): each folder in the payload (base64 JSON list) may be owned by and grant
# access to only this user, SYSTEM and Administrators. Prints each folder that fails and exits 1. Needs no C#.
if ($Mode -eq 'Acl') {
  $trusted = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  $folders = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  $bad = @($folders | Where-Object {
    $security = (Get-Item -LiteralPath $_ -Force).GetAccessControl('Access, Owner')
    $grants = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object AccessControlType -eq 'Allow')
    ($trusted -notcontains $security.GetOwner([Security.Principal.SecurityIdentifier]).Value) -or
      @($grants | Where-Object { $trusted -notcontains $_.IdentityReference.Value }).Count -gt 0
  })
  $bad
  exit ([int]($bad.Count -gt 0))
}

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class P9WindowsHost {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NEW_CONSOLE = 0x00000010;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const int JobObjectExtendedLimitInformation = 9;
    const int TokenDefaultDacl = 6;
    const uint INFINITE = 0xffffffff;
    const uint READ_CONTROL = 0x00020000;
    const uint WRITE_DAC = 0x00040000;
    const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_ALWAYS = 4;
    const uint FILE_APPEND_DATA = 0x0004;
    const uint FILE_READ_ATTRIBUTES = 0x0080;
    const uint SYNCHRONIZE = 0x00100000;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const int SE_KERNEL_OBJECT = 6;  // SE_FILE_OBJECT (1) returns ERROR_INVALID_PARAMETER for a pipe handle (Windows desktop, 2026-10-17)
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO {
        public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars;
        public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow;
        public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory,
        ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint info, out IntPtr owner, out IntPtr group,
        out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info,
        out IntPtr text, out uint length);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new [] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            output.Append('\\', slashes).Append(c); slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
    static IntPtr CreateKillJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits); IntPtr memory = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(limits, memory, false); Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, memory, (uint)size), "SetInformationJobObject"); }
        catch { CloseHandle(job); throw; }
        finally { Marshal.FreeHGlobal(memory); }
        return job;
    }
    static IntPtr EnvironmentBlock(IDictionary environment) {
        var entries = new List<string>();
        foreach (DictionaryEntry item in environment) entries.Add((string)item.Key + "=" + (string)item.Value);
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        return Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
    }
    static void RestrictDefaultDacl(IntPtr process) {
        IntPtr token; Check(OpenProcessToken(process, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out token), "OpenProcessToken");
        IntPtr aclMemory = IntPtr.Zero, infoMemory = IntPtr.Zero;
        try {
            string sid = WindowsIdentity.GetCurrent().User.Value;
            var descriptor = new RawSecurityDescriptor("D:P(A;;GA;;;" + sid + ")");
            byte[] acl = new byte[descriptor.DiscretionaryAcl.BinaryLength];
            descriptor.DiscretionaryAcl.GetBinaryForm(acl, 0);
            aclMemory = Marshal.AllocHGlobal(acl.Length); Marshal.Copy(acl, 0, aclMemory, acl.Length);
            infoMemory = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(infoMemory, aclMemory);
            Check(SetTokenInformation(token, TokenDefaultDacl, infoMemory, (uint)IntPtr.Size), "SetTokenInformation");
        } finally {
            if (infoMemory != IntPtr.Zero) Marshal.FreeHGlobal(infoMemory);
            if (aclMemory != IntPtr.Zero) Marshal.FreeHGlobal(aclMemory);
            CloseHandle(token);
        }
    }
    // A pipe created with no security attributes (always, from Node/libuv) gets the fixed named-pipe default, which
    // grants Everyone and Anonymous read; the token's default DACL does not apply. The owner replaces it after listen.
    // FA, not GA: generic bits in a stored ACE are not mapped at access-check time.
    public static void LockPipe(string name) {
        IntPtr handle = CreateFileW(name, READ_CONTROL | WRITE_DAC, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile(pipe)");
        try {
            string sid = WindowsIdentity.GetCurrent().User.Value;
            var acl = new RawSecurityDescriptor("D:P(A;;FA;;;" + sid + ")").DiscretionaryAcl;
            byte[] bytes = new byte[acl.BinaryLength]; acl.GetBinaryForm(bytes, 0);
            uint result = SetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, bytes, IntPtr.Zero);
            if (result != 0) throw new Win32Exception((int)result, "SetSecurityInfo(pipe)");
        } finally { CloseHandle(handle); }
    }
    public static string PipeAcl(string name) {
        IntPtr handle = CreateFileW(name, READ_CONTROL, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile(pipe)");
        IntPtr owner, group, dacl, sacl, descriptor, text = IntPtr.Zero;
        try {
            uint result = GetSecurityInfo(handle, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0) throw new Win32Exception((int)result, "GetSecurityInfo(pipe)");
            try {
                Check(ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, DACL_SECURITY_INFORMATION, out text, out result), "ConvertSecurityDescriptor");
                return Marshal.PtrToStringUni(text);
            } finally { if (text != IntPtr.Zero) LocalFree(text); LocalFree(descriptor); }
        } finally { CloseHandle(handle); }
    }
    // log: the child's stdout and stderr go to this file, appended (the scheduled task's daemon.log, issue #6 B4).
    // verbatim: the rest of the line is cmd.exe's own /c line (process-tree.mjs windowsArgv), which C quoting would break.
    static string Line(string[] command, bool verbatim) {
        if (command == null || command.Length < 1) throw new ArgumentException("command-required");
        return verbatim ? Quote(command[0]) + " " + String.Join(" ", command, 1, command.Length - 1) : String.Join(" ", Array.ConvertAll(command, Quote));
    }
    // A terminal button (D1): the child gets a new console window and outlives this host. No job of its own, no wait.
    // ponytail: it stays in the daemon's job, so a daemon restart closes the window; CREATE_BREAKAWAY_FROM_JOB if that matters.
    public static int Start(string[] command, IDictionary environment, bool verbatim) {
        string line = Line(command, verbatim);
        IntPtr environmentBlock = EnvironmentBlock(environment);
        try {
            var startup = new STARTUPINFOEX(); startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION process;
            Check(CreateProcessW(command[0], new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                environmentBlock, Environment.CurrentDirectory, ref startup, out process), "CreateProcess");
            CloseHandle(process.hThread); CloseHandle(process.hProcess);
            return 0;
        } finally { Marshal.FreeHGlobal(environmentBlock); }
    }
    public static int Run(string mode, string[] command, IDictionary environment, string log, bool verbatim) {
        string line = Line(command, verbatim);
        IntPtr job = CreateKillJob(), attributes = IntPtr.Zero, jobPointer = IntPtr.Zero, environmentBlock = IntPtr.Zero, logHandle = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
            jobPointer = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobPointer, job);
            Check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobPointer,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");
            var startup = new STARTUPINFOEX(); startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.lpAttributeList = attributes;
            startup.StartupInfo.hStdInput = GetStdHandle(-10); startup.StartupInfo.hStdOutput = GetStdHandle(-11); startup.StartupInfo.hStdError = GetStdHandle(-12);
            if (!String.IsNullOrEmpty(log)) {
                logHandle = CreateFileW(log, FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, 7, IntPtr.Zero, OPEN_ALWAYS, 0, IntPtr.Zero);
                if (logHandle == new IntPtr(-1)) { logHandle = IntPtr.Zero; throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile(log)"); }
                Check(SetHandleInformation(logHandle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT), "SetHandleInformation(log)");
                startup.StartupInfo.hStdOutput = logHandle; startup.StartupInfo.hStdError = logHandle;
            }
            environmentBlock = EnvironmentBlock(environment);
            Check(CreateProcessW(command[0], new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environmentBlock, Environment.CurrentDirectory, ref startup, out process), "CreateProcess");
            if (mode == "Daemon") RestrictDefaultDacl(process.hProcess);
            if (ResumeThread(process.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
            WaitForSingleObject(process.hProcess, INFINITE);
            uint code; Check(GetExitCodeProcess(process.hProcess, out code), "GetExitCodeProcess");
            return unchecked((int)code);
        } catch {
            if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
            throw;
        } finally {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (jobPointer != IntPtr.Zero) Marshal.FreeHGlobal(jobPointer);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (logHandle != IntPtr.Zero) CloseHandle(logHandle);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@
if ($Mode -eq 'Compile') { Add-Type -TypeDefinition $source -OutputAssembly $Out; exit 0 }
# E4: compiling the class costs every host start 1-3 s (csc). package-windows.mjs compiles it once, at build, beside this
# script in the installed app; a source run has no DLL and compiles here.
$dll = Join-Path $PSScriptRoot 'P9WindowsHost.dll'
if (Test-Path -LiteralPath $dll) { Add-Type -LiteralPath $dll } else { Add-Type -TypeDefinition $source }

if ($Mode -eq 'PipeAcl' -or $Mode -eq 'PipeLock') {
  if ([string]::IsNullOrWhiteSpace($Pipe)) { throw 'pipe-required' }
  # PipeLock (the daemon, right after listen) sets the owner-only DACL, then verifies it like PipeAcl (read-only) does.
  if ($Mode -eq 'PipeLock') { [P9WindowsHost]::LockPipe($Pipe) }
  $acl = [P9WindowsHost]::PipeAcl($Pipe)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  # Windows may store GA mapped to file rights (FA) and add ACE flags, so check the parsed ACEs, not the SDDL text.
  $aces = @((New-Object Security.AccessControl.RawSecurityDescriptor($acl)).DiscretionaryAcl)
  $bad = @($aces | Where-Object { $_.AceType -ne 'AccessAllowed' -or $_.SecurityIdentifier -ne $sid })
  $fullAccess = @($aces | Where-Object { ($_.AccessMask -band 0x10000000) -ne 0 -or ($_.AccessMask -band 0x001F01FF) -eq 0x001F01FF })
  if ($aces.Count -lt 1 -or $bad.Count -gt 0 -or $fullAccess.Count -lt 1) { throw 'pipe-acl-not-current-user-only' }
  $acl
  exit 0
}
if ([string]::IsNullOrWhiteSpace($Payload)) { throw 'payload-required' }
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$command = @($decoded.argv | ForEach-Object { [string]$_ })
$environment = @{}
$decoded.env.psobject.Properties | ForEach-Object { $environment[$_.Name] = [string]$_.Value }
if ($Log) {
  # ponytail: one old copy at 5 MB, checked when the host starts; a daemon that runs for weeks can grow it past that.
  if ((Test-Path -LiteralPath $Log) -and (Get-Item -LiteralPath $Log).Length -gt 5MB) { Move-Item -LiteralPath $Log -Destination ($Log + '.1') -Force }
  Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + ' host started')
}
$verbatim = [bool]$decoded.verbatim
if ($Mode -eq 'Console') { exit [P9WindowsHost]::Start($command, $environment, $verbatim) }
exit [P9WindowsHost]::Run($Mode, $command, $environment, $Log, $verbatim)
