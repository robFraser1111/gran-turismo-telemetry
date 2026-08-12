using GranTurismoTelemetry.Web.Hubs;
using GranTurismoTelemetry.Web.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<TelemetryOptions>(
    builder.Configuration.GetSection(TelemetryOptions.SectionName));

builder.Services.AddSingleton<TelemetryState>();
builder.Services.AddHostedService<TelemetryBroadcastService>();

builder.Services.AddSignalR().AddJsonProtocol(o =>
{
    // camelCase is friendlier for the JS client
    o.PayloadSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});
builder.Services.AddControllers().AddJsonOptions(o =>
{
    o.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
});

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapControllers();
app.MapHub<TelemetryHub>(TelemetryHub.EndpointPath);

app.Run();
