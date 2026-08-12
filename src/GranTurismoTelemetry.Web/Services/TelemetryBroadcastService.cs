using System.Net;
using GranTurismoTelemetry.Web.Gt7;
using GranTurismoTelemetry.Web.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace GranTurismoTelemetry.Web.Services;

/// <summary>
/// Long-running background service that owns the telemetry source (real UDP
/// client or simulator) and forwards decoded packets to all SignalR clients.
/// Broadcasts are rate-limited to <see cref="TelemetryOptions.BroadcastHz"/>.
/// </summary>
public sealed class TelemetryBroadcastService : BackgroundService
{
    private readonly IHubContext<TelemetryHub> _hub;
    private readonly TelemetryOptions _options;
    private readonly ILogger<TelemetryBroadcastService> _log;
    private readonly ILoggerFactory _loggerFactory;
    private readonly TelemetryState _state;

    public TelemetryBroadcastService(
        IHubContext<TelemetryHub> hub,
        IOptions<TelemetryOptions> options,
        TelemetryState state,
        ILogger<TelemetryBroadcastService> log,
        ILoggerFactory loggerFactory)
    {
        _hub = hub;
        _options = options.Value;
        _state = state;
        _log = log;
        _loggerFactory = loggerFactory;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        long minTicksBetweenBroadcasts = TimeSpan.FromSeconds(1.0 / Math.Max(1, _options.BroadcastHz)).Ticks;
        long lastBroadcast = 0;

        void OnPacket(TelemetryPacket p)
        {
            _state.LastPacket = p;
            _state.MarkDecoded();
            long now = DateTime.UtcNow.Ticks;
            if (now - lastBroadcast < minTicksBetweenBroadcasts) return;
            lastBroadcast = now;

            // Fire and forget: SignalR broadcast; failures are logged inside.
            _ = _hub.Clients.All.SendAsync(TelemetryHub.EventName, p, stoppingToken);
        }

        try
        {
            if (_options.UseSimulator)
            {
                _log.LogInformation("Starting telemetry SIMULATOR (UseSimulator=true)");
                _state.Mode = "simulator";
                var sim = new TelemetrySimulator();
                sim.PacketReceived += p =>
                {
                    // The simulator produces already-decoded packets, so every "raw" is
                    // by definition a successful decode.
                    _state.MarkRawReceived();
                    OnPacket(p);
                };
                await sim.RunAsync(stoppingToken);
            }
            else
            {
                if (!IPAddress.TryParse(_options.Ps5Ip, out var ip))
                {
                    _log.LogError("Invalid Telemetry:Ps5Ip '{Ip}' - falling back to simulator", _options.Ps5Ip);
                    _state.Mode = "simulator";
                    var sim = new TelemetrySimulator();
                    sim.PacketReceived += p =>
                    {
                        _state.MarkRawReceived();
                        OnPacket(p);
                    };
                    await sim.RunAsync(stoppingToken);
                    return;
                }

                _log.LogInformation("Starting real GT7 UDP client -> {Ip}", ip);
                _state.Mode = "udp";
                var client = new Gt7UdpClient(
                    ip,
                    _options.SendPort,
                    _options.ReceivePort,
                    _loggerFactory.CreateLogger<Gt7UdpClient>());
                client.RawPacketReceived += _ => _state.MarkRawReceived();
                client.DecodeFailed      += reason => _state.MarkDecodeFailed(reason);
                client.PacketReceived    += OnPacket;
                await client.RunAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) { /* normal shutdown */ }
        catch (Exception ex)
        {
            _log.LogError(ex, "Telemetry broadcast service crashed");
        }
    }
}

/// <summary>Shared, thread-safe snapshot of the latest known telemetry (for REST + late joiners).</summary>
public sealed class TelemetryState
{
    private long _rawReceived;
    private long _decoded;
    private long _decodeFailures;

    public TelemetryPacket? LastPacket { get; set; }
    public string Mode { get; set; } = "unknown";

    /// <summary>Total UDP datagrams received on the telemetry port (any size, valid or not).</summary>
    public long RawPacketsReceived => Interlocked.Read(ref _rawReceived);

    /// <summary>Total telemetry packets successfully decrypted and parsed.</summary>
    public long DecodedPackets => Interlocked.Read(ref _decoded);

    /// <summary>Datagrams that arrived but couldn't be decoded (too short, bad magic, parse error).</summary>
    public long DecodeFailures => Interlocked.Read(ref _decodeFailures);

    /// <summary>UTC timestamp of the last successfully decoded packet, or null if none yet.</summary>
    public DateTime? LastPacketAtUtc { get; set; }

    /// <summary>UTC timestamp of the last raw datagram received (any size), or null if none yet.</summary>
    public DateTime? LastRawReceivedAtUtc { get; set; }

    /// <summary>Reason for the most recent decode failure (short, human-readable), or null.</summary>
    public string? LastDecodeError { get; set; }

    internal void MarkRawReceived()
    {
        Interlocked.Increment(ref _rawReceived);
        LastRawReceivedAtUtc = DateTime.UtcNow;
    }

    internal void MarkDecoded()
    {
        Interlocked.Increment(ref _decoded);
        LastPacketAtUtc = DateTime.UtcNow;
    }

    internal void MarkDecodeFailed(string reason)
    {
        Interlocked.Increment(ref _decodeFailures);
        LastDecodeError = reason;
    }
}
