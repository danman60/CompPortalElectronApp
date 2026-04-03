using System.Text.Json;
using MediaDevices;

namespace CompSync.WpdHelper;

internal sealed class CommandEnvelope
{
    public string? Id { get; set; }
    public string? Command { get; set; }
    public string? DeviceId { get; set; }
    public string? StagingDir { get; set; }
}

internal sealed class DeviceInfo
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public string? Manufacturer { get; set; }
}

internal sealed class PhotoSidecar
{
    public required string Filename { get; set; }
    public string? DeviceName { get; set; }
    public string? CaptureTime { get; set; }
    public required string TransferredAt { get; set; }
}

internal static class Program
{
    private static readonly JsonSerializerOptions JOpt = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> PhotoExts = new(StringComparer.OrdinalIgnoreCase)
        { ".jpg", ".jpeg", ".arw", ".cr3", ".nef", ".raf", ".rw2" };
    private static readonly object MonLock = new();

    private static CancellationTokenSource? _monCts;
    private static Task? _monTask;
    private static string? _devId, _devName, _staging;
    private static MediaDevice? _device;
    private static HashSet<string> _knownFiles = new(StringComparer.OrdinalIgnoreCase);

    private static async Task<int> Main()
    {
        await Log("info", "wpd-helper started (v4 — MediaDevices)");

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            CommandEnvelope? cmd;
            try { cmd = JsonSerializer.Deserialize<CommandEnvelope>(line, JOpt); }
            catch (Exception ex) { await Log("error", $"bad json: {ex.Message}"); continue; }
            if (cmd?.Command is null) { await Resp(cmd?.Id, false, error: "missing command"); continue; }

            try
            {
                switch (cmd.Command)
                {
                    case "MONITOR_START":
                        StartMonitor();
                        await Resp(cmd.Id, true, new { monitoring = true });
                        break;
                    case "LIST_DEVICES":
                        await Resp(cmd.Id, true, GetDevices());
                        break;
                    case "WATCH":
                        if (string.IsNullOrWhiteSpace(cmd.DeviceId) || string.IsNullOrWhiteSpace(cmd.StagingDir))
                        { await Resp(cmd.Id, false, error: "WATCH needs deviceId + stagingDir"); break; }
                        Directory.CreateDirectory(cmd.StagingDir);
                        Disconnect();
                        _devId = cmd.DeviceId;
                        _staging = cmd.StagingDir;
                        var mode = await StartWatch(cmd.DeviceId, cmd.StagingDir);
                        await Resp(cmd.Id, true, new { watching = true, deviceId = _devId, stagingDir = _staging, mode });
                        break;
                    case "STOP":
                        Disconnect();
                        _devId = null; _devName = null; _staging = null;
                        await Resp(cmd.Id, true, new { watching = false });
                        break;
                    case "QUIT":
                        Disconnect();
                        await StopMonitor();
                        await Resp(cmd.Id, true, new { quitting = true });
                        return 0;
                    default:
                        await Resp(cmd.Id, false, error: $"unknown: {cmd.Command}");
                        break;
                }
            }
            catch (Exception ex) { await Resp(cmd.Id, false, error: ex.Message); }
        }
        Disconnect();
        await StopMonitor();
        return 0;
    }

    // --- Watch via MediaDevices ---

    private static async Task<string> StartWatch(string deviceId, string stagingDir)
    {
        try
        {
            var devices = MediaDevice.GetDevices().ToList();
            await Log("info", $"Found {devices.Count} device(s): {string.Join(", ", devices.Select(d => d.FriendlyName))}");

            var device = devices.FirstOrDefault(d =>
                string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
            if (device is null)
                device = devices.FirstOrDefault(d =>
                    deviceId.IndexOf(d.FriendlyName ?? "", StringComparison.OrdinalIgnoreCase) >= 0);
            if (device is null && devices.Count > 0)
                device = devices[0];
            if (device is null)
                throw new Exception("No WPD devices found");

            _devName = device.FriendlyName;
            await Log("info", $"Connecting to {device.FriendlyName} ({device.Manufacturer ?? "unknown"})");

            device.Connect();
            _device = device;

            // Snapshot existing files on device
            _knownFiles = SnapshotDevicePhotos(device);
            await Log("info", $"Connected. Snapshot: {_knownFiles.Count} existing photo(s)");

            // Subscribe to ObjectAdded — fires when camera captures a photo
            device.ObjectAdded += (sender, e) =>
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await Log("info", "WPD ObjectAdded event fired — scanning for new photos");
                        await ScanForNewPhotos();
                    }
                    catch (Exception ex)
                    {
                        await Log("error", $"ObjectAdded scan failed: {ex.Message}");
                    }
                });
            };

            await Log("info", $"WPD event watch active for {device.FriendlyName}");
            return "wpd-event-driven";
        }
        catch (Exception ex)
        {
            await Log("error", $"MediaDevices connect failed: {ex.Message}");
            _device = null;
            throw;
        }
    }

    private static HashSet<string> SnapshotDevicePhotos(MediaDevice device)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            // Enumerate all files on device
            var root = device.GetRootDirectory();
            ScanDirectory(root, result);
        }
        catch (Exception ex)
        {
            _ = Log("warn", $"Snapshot scan failed: {ex.Message}");
        }
        return result;
    }

    private static void ScanDirectory(MediaDirectoryInfo dir, HashSet<string> files)
    {
        try
        {
            foreach (var file in dir.EnumerateFiles())
            {
                var ext = Path.GetExtension(file.Name);
                if (PhotoExts.Contains(ext))
                    files.Add(file.FullName);
            }
            foreach (var sub in dir.EnumerateDirectories())
            {
                ScanDirectory(sub, files);
            }
        }
        catch { }
    }

    private static async Task ScanForNewPhotos()
    {
        if (_device is null || _staging is null) return;

        var currentFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var root = _device.GetRootDirectory();
            ScanDirectory(root, currentFiles);
        }
        catch (Exception ex)
        {
            await Log("error", $"Device scan failed: {ex.Message}");
            return;
        }

        // Find new files
        var newFiles = currentFiles.Where(f => !_knownFiles.Contains(f)).ToList();
        if (newFiles.Count == 0)
        {
            await Log("debug", "ObjectAdded but no new photo files found");
            return;
        }

        await Log("info", $"Found {newFiles.Count} new photo(s)");

        foreach (var devicePath in newFiles)
        {
            _knownFiles.Add(devicePath);
            var fileName = Path.GetFileName(devicePath);
            await Log("info", $"Transferring: {fileName}");

            try
            {
                var transferDir = Path.Combine(_staging,
                    $"{DateTime.UtcNow:yyyyMMdd_HHmmssfff}_{fileName.GetHashCode():X8}");
                Directory.CreateDirectory(transferDir);
                var destPath = Path.Combine(transferDir, fileName);

                using (var fs = File.Create(destPath))
                {
                    _device.DownloadFile(devicePath, fs);
                }

                var size = new FileInfo(destPath).Length;
                await Log("info", $"Transferred: {fileName} -> {destPath} ({size / 1024}KB)");

                await WriteSidecar(destPath, _devName, null);
                await PhotoEvent(destPath, _devName, null, $"{destPath}.json");
            }
            catch (Exception ex)
            {
                await Log("error", $"Transfer failed for {fileName}: {ex.Message}");
            }
        }
    }

    private static void Disconnect()
    {
        if (_device is not null)
        {
            try { _device.Disconnect(); } catch { }
            _device = null;
            _knownFiles.Clear();
            _ = Log("info", "Device disconnected");
        }
    }

    // --- Device monitoring ---

    private static void StartMonitor()
    {
        lock (MonLock)
        {
            if (_monTask is not null) return;
            _monCts = new CancellationTokenSource();
            _monTask = Task.Run(() => MonLoop(_monCts.Token));
        }
    }

    private static async Task StopMonitor()
    {
        CancellationTokenSource? cts; Task? task;
        lock (MonLock) { cts = _monCts; task = _monTask; _monCts = null; _monTask = null; }
        if (cts is null || task is null) return;
        cts.Cancel();
        try { await task; } catch (OperationCanceledException) { } finally { cts.Dispose(); }
    }

    private static async Task MonLoop(CancellationToken ct)
    {
        var known = new Dictionary<string, DeviceInfo>(StringComparer.OrdinalIgnoreCase);
        while (!ct.IsCancellationRequested)
        {
            List<DeviceInfo> devs;
            try { devs = GetDevices(); } catch { devs = []; }
            var map = devs.ToDictionary(d => d.Id, StringComparer.OrdinalIgnoreCase);
            foreach (var d in map.Values)
                if (!known.ContainsKey(d.Id)) await DevEvent("device-connected", d);
            foreach (var d in known.Values)
                if (!map.ContainsKey(d.Id)) await DevEvent("device-disconnected", d);
            known = map;

            try { await Task.Delay(5000, ct); } catch (OperationCanceledException) { break; }
        }
    }

    private static List<DeviceInfo> GetDevices()
    {
        var result = new List<DeviceInfo>();
        try
        {
            foreach (var device in MediaDevice.GetDevices())
            {
                result.Add(new DeviceInfo
                {
                    Id = device.DeviceId ?? "",
                    Name = device.FriendlyName ?? device.Description ?? "Unknown",
                    Manufacturer = device.Manufacturer,
                });
            }
        }
        catch (Exception ex)
        {
            _ = Log("warn", $"Device enumeration failed: {ex.Message}");
        }
        return result;
    }

    // --- JSON output ---

    private static async Task Log(string level, string msg)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { type = "log", level, message = msg }, JOpt));
        await Console.Out.FlushAsync();
    }

    private static async Task Resp(string? id, bool ok, object? result = null, string? error = null)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { type = "response", id, ok, result, error }, JOpt));
        await Console.Out.FlushAsync();
    }

    private static async Task DevEvent(string eventType, DeviceInfo device)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { type = eventType, device }, JOpt));
        await Console.Out.FlushAsync();
    }

    private static async Task PhotoEvent(string path, string? deviceName, string? captureTime, string metadataPath)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { type = "photo", path, deviceName, captureTime, metadataPath }, JOpt));
        await Console.Out.FlushAsync();
    }

    private static async Task WriteSidecar(string path, string? deviceName, string? captureTime)
    {
        var sc = new PhotoSidecar { Filename = Path.GetFileName(path), DeviceName = deviceName, CaptureTime = captureTime, TransferredAt = DateTime.UtcNow.ToString("O") };
        await File.WriteAllTextAsync($"{path}.json", JsonSerializer.Serialize(sc, JOpt));
    }
}
