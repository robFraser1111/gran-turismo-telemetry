using GranTurismoTelemetry.Web.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace GranTurismoTelemetry.Web.Controllers;

/// <summary>Read-only REST endpoints for status and last-known telemetry.</summary>
[ApiController]
[Route("api/telemetry")]
public sealed class TelemetryController : ControllerBase
{
    private readonly TelemetryState _state;
    private readonly TelemetryOptions _options;

    public TelemetryController(TelemetryState state, IOptions<TelemetryOptions> options)
    {
        _state = state;
        _options = options.Value;
    }

    /// <summary>Basic runtime status for the dashboard header.</summary>
    [HttpGet("status")]
    public object GetStatus()
    {
        var now = DateTime.UtcNow;
        double? msSinceLastPacket = _state.LastPacketAtUtc is { } t
            ? (now - t).TotalMilliseconds
            : null;
        double? msSinceLastRaw = _state.LastRawReceivedAtUtc is { } r
            ? (now - r).TotalMilliseconds
            : null;

        return new
        {
            mode = _state.Mode,
            useSimulator = _options.UseSimulator,
            ps5Ip = _options.Ps5Ip,
            sendPort = _options.SendPort,
            receivePort = _options.ReceivePort,
            broadcastHz = _options.BroadcastHz,
            hasPacket = _state.LastPacket is not null,

            // Diagnostics — useful when the browser reports "connected" but no telemetry
            // is coming through.
            rawPacketsReceived = _state.RawPacketsReceived,
            decodedPackets     = _state.DecodedPackets,
            decodeFailures     = _state.DecodeFailures,
            lastPacketAtUtc    = _state.LastPacketAtUtc,
            lastRawReceivedAtUtc = _state.LastRawReceivedAtUtc,
            msSinceLastPacket,
            msSinceLastRaw,
            lastDecodeError    = _state.LastDecodeError,
        };
    }

    /// <summary>Last decoded packet, or 204 if nothing yet.</summary>
    [HttpGet("latest")]
    public IActionResult GetLatest()
        => _state.LastPacket is { } p ? Ok(p) : NoContent();
}
