using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

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

[ComImport]
[Guid("A1567595-4C2F-4574-A6FA-ECEF917B9A40")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPortableDeviceManager
{
    void GetDevices([MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] [Out] string[]? pPnPDeviceIDs, ref uint pcPnPDeviceIDs);
    void RefreshDeviceList();
    void GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder? pDeviceFriendlyName, ref uint pcchDeviceFriendlyName);
    void GetDeviceDescription([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder? pDeviceDescription, ref uint pcchDeviceDescription);
    void GetDeviceManufacturer([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder? pDeviceManufacturer, ref uint pcchDeviceManufacturer);
    void GetDeviceProperty([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [MarshalAs(UnmanagedType.LPWStr)] string pszDevicePropertyName, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder? pData, ref uint pcbData, ref uint pdwType);
    void GetPrivateDevices([MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] [Out] string[]? pPnPDeviceIDs, ref uint pcPnPDeviceIDs);
}

[ComImport]
[Guid("0AF10CEC-2ECD-4B92-9581-34F6AE0637F3")]
internal sealed class PortableDeviceManagerClass
{
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly object MonitorLock = new();

    private static CancellationTokenSource? _monitorCts;
    private static Task? _monitorTask;
    private static string? _watchedDeviceId;
    private static string? _watchedDeviceName;
    private static string? _stagingDir;
    private static readonly HashSet<string> SeenPhotoKeys = new(StringComparer.OrdinalIgnoreCase);
    private static readonly string[] PhotoExtensions = [".jpg", ".jpeg", ".arw", ".cr3", ".nef", ".raf"];

    private static async Task<int> Main()
    {
        await WriteLog("info", "wpd-helper started");

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            CommandEnvelope? command;
            try
            {
                command = JsonSerializer.Deserialize<CommandEnvelope>(line, JsonOptions);
            }
            catch (Exception ex)
            {
                await WriteLog("error", $"invalid command json: {ex.Message}");
                continue;
            }

            if (command?.Command is null)
            {
                await WriteResponse(command?.Id, false, error: "Missing command");
                continue;
            }

            try
            {
                switch (command.Command)
                {
                    case "MONITOR_START":
                        StartMonitor();
                        await WriteResponse(command.Id, true, new { monitoring = true });
                        break;

                    case "LIST_DEVICES":
                        await WriteResponse(command.Id, true, EnumerateDevices());
                        break;

                    case "WATCH":
                        if (string.IsNullOrWhiteSpace(command.DeviceId) || string.IsNullOrWhiteSpace(command.StagingDir))
                        {
                            await WriteResponse(command.Id, false, error: "WATCH requires deviceId and stagingDir");
                            break;
                        }

                        Directory.CreateDirectory(command.StagingDir);
                        _watchedDeviceId = command.DeviceId;
                        _stagingDir = command.StagingDir;
                        _watchedDeviceName = EnumerateDevices().FirstOrDefault(device => string.Equals(device.Id, command.DeviceId, StringComparison.OrdinalIgnoreCase))?.Name;
                        SeenPhotoKeys.Clear();
                        foreach (var key in SnapshotWatchedPhotoKeys())
                        {
                            SeenPhotoKeys.Add(key);
                        }
                        await WriteLog("info", $"watch requested for {command.DeviceId} -> {command.StagingDir}");
                        await WriteResponse(command.Id, true, new
                        {
                            watching = true,
                            deviceId = _watchedDeviceId,
                            stagingDir = _stagingDir,
                            mode = "shell-poll-transfer",
                        });
                        break;

                    case "STOP":
                        _watchedDeviceId = null;
                        _watchedDeviceName = null;
                        _stagingDir = null;
                        SeenPhotoKeys.Clear();
                        await WriteResponse(command.Id, true, new { watching = false });
                        break;

                    case "QUIT":
                        await StopMonitor();
                        await WriteResponse(command.Id, true, new { quitting = true });
                        return 0;

                    default:
                        await WriteResponse(command.Id, false, error: $"Unsupported command: {command.Command}");
                        break;
                }
            }
            catch (Exception ex)
            {
                await WriteResponse(command.Id, false, error: ex.Message);
            }
        }

        await StopMonitor();
        return 0;
    }

    private static void StartMonitor()
    {
        lock (MonitorLock)
        {
            if (_monitorTask is not null)
            {
                return;
            }

            _monitorCts = new CancellationTokenSource();
            _monitorTask = Task.Run(() => MonitorLoop(_monitorCts.Token));
        }
    }

    private static async Task StopMonitor()
    {
        CancellationTokenSource? cts;
        Task? task;

        lock (MonitorLock)
        {
            cts = _monitorCts;
            task = _monitorTask;
            _monitorCts = null;
            _monitorTask = null;
        }

        if (cts is null || task is null)
        {
            return;
        }

        cts.Cancel();
        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            cts.Dispose();
        }
    }

    private static async Task MonitorLoop(CancellationToken cancellationToken)
    {
        var known = new Dictionary<string, DeviceInfo>(StringComparer.OrdinalIgnoreCase);

        while (!cancellationToken.IsCancellationRequested)
        {
            IReadOnlyList<DeviceInfo> currentDevices;
            try
            {
                currentDevices = EnumerateDevices();
            }
            catch (Exception ex)
            {
                await WriteLog("warn", $"monitor enumerate failed: {ex.Message}");
                currentDevices = Array.Empty<DeviceInfo>();
            }

            var currentMap = currentDevices.ToDictionary(device => device.Id, StringComparer.OrdinalIgnoreCase);

            foreach (var current in currentMap.Values)
            {
                if (!known.ContainsKey(current.Id))
                {
                    await WriteDeviceEvent("device-connected", current);
                }
            }

            foreach (var previous in known.Values)
            {
                if (!currentMap.ContainsKey(previous.Id))
                {
                    await WriteDeviceEvent("device-disconnected", previous);
                }
            }

            known = currentMap;

            if (!string.IsNullOrWhiteSpace(_watchedDeviceId) &&
                !string.IsNullOrWhiteSpace(_watchedDeviceName) &&
                !string.IsNullOrWhiteSpace(_stagingDir))
            {
                try
                {
                    await ScanWatchedDeviceForPhotos(_watchedDeviceName!, _stagingDir!);
                }
                catch (Exception ex)
                {
                    await WriteLog("warn", $"photo scan failed: {ex.Message}");
                }
            }

            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    private static IEnumerable<string> SnapshotWatchedPhotoKeys()
    {
        if (string.IsNullOrWhiteSpace(_watchedDeviceName))
        {
            return Array.Empty<string>();
        }

        return EnumerateShellPhotos(_watchedDeviceName!)
            .Select(item => item.Key)
            .ToArray();
    }

    private static async Task ScanWatchedDeviceForPhotos(string deviceName, string stagingDir)
    {
        foreach (var item in EnumerateShellPhotos(deviceName))
        {
            if (!SeenPhotoKeys.Add(item.Key))
            {
                continue;
            }

            var stagedPath = await CopyItemToStaging(item.Item, item.FileName, stagingDir);
            var captureTime = TryGetShellCaptureTime(item.Item);
            await WritePhotoSidecar(stagedPath, deviceName, captureTime);
            await WritePhotoEvent(stagedPath, deviceName, captureTime, $"{stagedPath}.json");
        }
    }

    private static IEnumerable<(string Key, string FileName, dynamic Item)> EnumerateShellPhotos(string deviceName)
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Shell.Application COM object is not available");
        dynamic shell = Activator.CreateInstance(shellType) ?? throw new InvalidOperationException("Failed to create Shell.Application");
        dynamic myComputer = shell.NameSpace("shell:MyComputerFolder") ?? throw new InvalidOperationException("My Computer shell folder is not available");
        dynamic? deviceFolder = null;

        foreach (var item in myComputer.Items())
        {
            var name = Convert.ToString(item.Name) ?? string.Empty;
            if (string.Equals(name, deviceName, StringComparison.OrdinalIgnoreCase))
            {
                deviceFolder = item.GetFolder;
                break;
            }
        }

        if (deviceFolder is null)
        {
          yield break;
        }

        foreach (var result in EnumerateShellFolder(deviceFolder))
        {
            yield return result;
        }
    }

    private static IEnumerable<(string Key, string FileName, dynamic Item)> EnumerateShellFolder(dynamic folder)
    {
        foreach (var item in folder.Items())
        {
            var isFolder = false;
            try
            {
                isFolder = item.IsFolder;
            }
            catch
            {
                isFolder = false;
            }

            if (isFolder)
            {
                dynamic? childFolder = null;
                try
                {
                    childFolder = item.GetFolder;
                }
                catch
                {
                    childFolder = null;
                }

                if (childFolder is not null)
                {
                    foreach (var child in EnumerateShellFolder(childFolder))
                    {
                        yield return child;
                    }
                }

                continue;
            }

            string name = Convert.ToString(item.Name) ?? string.Empty;
            string extension = Path.GetExtension(name);
            if (!PhotoExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            var pathValue = string.Empty;
            try
            {
                pathValue = Convert.ToString(item.Path) ?? string.Empty;
            }
            catch
            {
                pathValue = string.Empty;
            }

            var key = string.IsNullOrWhiteSpace(pathValue) ? name : pathValue;
            yield return (key, name, item);
        }
    }

    private static async Task<string> CopyItemToStaging(dynamic item, string fileName, string stagingDir)
    {
        Directory.CreateDirectory(stagingDir);
        var transferDir = Path.Combine(
            stagingDir,
            $"{DateTime.UtcNow:yyyyMMdd_HHmmssfff}_{Guid.NewGuid():N}");
        Directory.CreateDirectory(transferDir);
        var finalPath = Path.Combine(transferDir, fileName);

        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Shell.Application COM object is not available");
        dynamic shell = Activator.CreateInstance(shellType) ?? throw new InvalidOperationException("Failed to create Shell.Application");
        dynamic destinationFolder = shell.NameSpace(transferDir) ?? throw new InvalidOperationException("Staging shell folder is not available");
        destinationFolder.CopyHere(item, 16);

        var timeoutAt = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < timeoutAt)
        {
            if (File.Exists(finalPath))
            {
                return finalPath;
            }

            var stagedFiles = Directory.GetFiles(transferDir);
            if (stagedFiles.Length > 0)
            {
                return stagedFiles[0];
            }

            await Task.Delay(250);
        }

        throw new IOException($"Timed out waiting for file copy to complete: {finalPath}");
    }

    private static IReadOnlyList<DeviceInfo> EnumerateDevices()
    {
        var managerType = Type.GetTypeFromCLSID(new Guid("0AF10CEC-2ECD-4B92-9581-34F6AE0637F3"))!;
        var manager = (IPortableDeviceManager)Activator.CreateInstance(managerType)!;
        manager.RefreshDeviceList();

        uint count = 0;
        manager.GetDevices(null, ref count);
        if (count == 0)
        {
            return Array.Empty<DeviceInfo>();
        }

        var ids = new string[count];
        manager.GetDevices(ids, ref count);

        var devices = new List<DeviceInfo>((int)count);
        for (var i = 0; i < count; i++)
        {
            var id = ids[i];
            if (string.IsNullOrWhiteSpace(id))
            {
                continue;
            }

            devices.Add(new DeviceInfo
            {
                Id = id,
                Name = GetStringProperty(manager, id, GetFriendlyName)
                    ?? GetStringProperty(manager, id, GetDescription)
                    ?? id,
                Manufacturer = GetStringProperty(manager, id, GetManufacturer),
            });
        }

        return devices;
    }

    private delegate void WpdStringMethod(IPortableDeviceManager manager, string deviceId, StringBuilder? buffer, ref uint size);

    private static void GetFriendlyName(IPortableDeviceManager manager, string deviceId, StringBuilder? buffer, ref uint size)
    {
        manager.GetDeviceFriendlyName(deviceId, buffer, ref size);
    }

    private static void GetDescription(IPortableDeviceManager manager, string deviceId, StringBuilder? buffer, ref uint size)
    {
        manager.GetDeviceDescription(deviceId, buffer, ref size);
    }

    private static void GetManufacturer(IPortableDeviceManager manager, string deviceId, StringBuilder? buffer, ref uint size)
    {
        manager.GetDeviceManufacturer(deviceId, buffer, ref size);
    }

    private static string? GetStringProperty(IPortableDeviceManager manager, string deviceId, WpdStringMethod method)
    {
        uint size = 0;
        method(manager, deviceId, null, ref size);
        if (size == 0)
        {
            return null;
        }

        var buffer = new StringBuilder((int)size);
        method(manager, deviceId, buffer, ref size);
        return buffer.ToString();
    }

    private static string? TryGetShellCaptureTime(dynamic item)
    {
        try
        {
            var raw = item.ExtendedProperty("System.Photo.DateTaken");
            if (raw is DateTime dateTime)
            {
                return dateTime.ToUniversalTime().ToString("O");
            }

            var asString = Convert.ToString(raw);
            if (DateTime.TryParse(asString, out DateTime parsed))
            {
                return parsed.ToUniversalTime().ToString("O");
            }
        }
        catch
        {
        }

        return null;
    }

    private static async Task WritePhotoSidecar(string path, string? deviceName, string? captureTime)
    {
        var sidecar = new PhotoSidecar
        {
            Filename = Path.GetFileName(path),
            DeviceName = deviceName,
            CaptureTime = captureTime,
            TransferredAt = DateTime.UtcNow.ToString("O"),
        };

        await File.WriteAllTextAsync(
            $"{path}.json",
            JsonSerializer.Serialize(sidecar, JsonOptions));
    }

    private static async Task WriteResponse(string? id, bool ok, object? result = null, string? error = null)
    {
        var payload = new
        {
            type = "response",
            id,
            ok,
            result,
            error,
        };

        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOptions));
        await Console.Out.FlushAsync();
    }

    private static async Task WriteLog(string level, string message)
    {
        var payload = new
        {
            type = "log",
            level,
            message,
        };

        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOptions));
        await Console.Out.FlushAsync();
    }

    private static async Task WriteDeviceEvent(string eventType, DeviceInfo device)
    {
        var payload = new
        {
            type = eventType,
            device,
        };

        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOptions));
        await Console.Out.FlushAsync();
    }

    private static async Task WritePhotoEvent(string path, string? deviceName, string? captureTime, string metadataPath)
    {
        var payload = new
        {
            type = "photo",
            path,
            deviceName,
            captureTime,
            metadataPath,
        };

        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOptions));
        await Console.Out.FlushAsync();
    }
}
