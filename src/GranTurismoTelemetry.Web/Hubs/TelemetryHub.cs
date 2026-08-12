using Microsoft.AspNetCore.SignalR;

namespace GranTurismoTelemetry.Web.Hubs;

/// <summary>
/// SignalR hub used purely for server->client push. Clients don't invoke
/// anything server-side; they just listen for the "telemetry" event.
/// </summary>
public sealed class TelemetryHub : Hub
{
    public const string EndpointPath = "/hubs/telemetry";
    public const string EventName    = "telemetry";
}
