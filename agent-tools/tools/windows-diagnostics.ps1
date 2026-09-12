$ErrorActionPreference = "Continue"

$result = [ordered]@{}

$result.Timestamp = (Get-Date).ToString("o")

$result.Computer = @{
    Name = $env:COMPUTERNAME
    User = $env:USERNAME
}

$result.OS = Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption,Version,BuildNumber,LastBootUpTime

$result.NetworkAdapters =
    Get-NetAdapter -ErrorAction SilentlyContinue |
    Select-Object Name,InterfaceDescription,Status,MacAddress,LinkSpeed

$result.IPAddresses =
    Get-NetIPAddress -ErrorAction SilentlyContinue |
    Select-Object InterfaceAlias,AddressFamily,IPAddress,PrefixLength

$result.Routes =
    Get-NetRoute -ErrorAction SilentlyContinue |
    Select-Object InterfaceAlias,DestinationPrefix,NextHop,RouteMetric

$result.Listeners =
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,OwningProcess

$result.Connections =
    Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess

$result.Processes =
    Get-Process -ErrorAction SilentlyContinue |
    Sort-Object CPU -Descending |
    Select-Object -First 50 Name,Id,CPU,WorkingSet,Path

$result.Services =
    Get-Service -ErrorAction SilentlyContinue |
    Where-Object Status -eq "Running" |
    Select-Object Name,DisplayName,Status

$result | ConvertTo-Json -Depth 15

