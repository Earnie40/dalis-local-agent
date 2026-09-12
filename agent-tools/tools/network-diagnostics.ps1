param(
    [string]$HostName = ""
)

$ErrorActionPreference = "Continue"

$result = [ordered]@{
    Timestamp = (Get-Date).ToString("o")
}

$result.Adapters =
    Get-NetAdapter -ErrorAction SilentlyContinue |
    Select-Object Name,Status,MacAddress,LinkSpeed

$result.IP =
    Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Select-Object InterfaceAlias,IPv4Address,IPv6Address,IPv4DefaultGateway,DNSServer

$result.Routes =
    Get-NetRoute -ErrorAction SilentlyContinue |
    Select-Object DestinationPrefix,NextHop,InterfaceAlias,RouteMetric

$result.EstablishedTCP =
    Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess

$result.ListeningTCP =
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,OwningProcess

if ($HostName) {

    $result.DNS =
        Resolve-DnsName $HostName -ErrorAction SilentlyContinue |
        Select-Object Name,Type,IPAddress

    $result.ConnectionTest =
        Test-NetConnection $HostName -InformationLevel Detailed `
        -ErrorAction SilentlyContinue
}

$result | ConvertTo-Json -Depth 15

