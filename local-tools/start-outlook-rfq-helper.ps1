$ErrorActionPreference = "Stop"

$prefix = "http://127.0.0.1:47321/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "PRF Material Outlook helper listening on $prefix"
Write-Host "Press Ctrl+C to stop."

function Send-JsonResponse {
  param(
    [Parameter(Mandatory = $true)] $Context,
    [Parameter(Mandatory = $true)] [int] $StatusCode,
    [Parameter(Mandatory = $true)] $Payload
  )
  $json = $Payload | ConvertTo-Json -Depth 5
  $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = "application/json"
  $response.Headers["Access-Control-Allow-Origin"] = "*"
  $response.Headers["Access-Control-Allow-Headers"] = "Content-Type"
  $response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
  $response.Headers["Access-Control-Allow-Private-Network"] = "true"
  $response.ContentLength64 = $buffer.Length
  $response.OutputStream.Write($buffer, 0, $buffer.Length)
  $response.OutputStream.Close()
}

function Send-EmptyResponse {
  param(
    [Parameter(Mandatory = $true)] $Context,
    [Parameter(Mandatory = $true)] [int] $StatusCode
  )
  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.Headers["Access-Control-Allow-Origin"] = "*"
  $response.Headers["Access-Control-Allow-Headers"] = "Content-Type"
  $response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
  $response.Headers["Access-Control-Allow-Private-Network"] = "true"
  $response.OutputStream.Close()
}

function New-TemporaryAttachmentPath {
  param(
    [Parameter(Mandatory = $true)] [string] $Filename
  )
  $safeName = [System.IO.Path]::GetFileName($Filename)
  if ([string]::IsNullOrWhiteSpace($safeName)) {
    $safeName = "RFQ.pdf"
  }
  $folder = Join-Path $env:TEMP "prf-material-outlook"
  if (-not (Test-Path -LiteralPath $folder)) {
    New-Item -ItemType Directory -Path $folder | Out-Null
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  return Join-Path $folder ($stamp + "-" + $safeName)
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  try {
    $request = $context.Request
    if ($request.HttpMethod -eq "OPTIONS") {
      Send-EmptyResponse -Context $context -StatusCode 204
      continue
    }

    if ($request.HttpMethod -eq "GET" -and $request.Url.AbsolutePath -eq "/health") {
      Send-JsonResponse -Context $context -StatusCode 200 -Payload @{ ok = $true; service = "outlook-rfq-helper" }
      continue
    }

    if ($request.HttpMethod -ne "POST" -or $request.Url.AbsolutePath -ne "/outlook/rfq-draft") {
      Send-JsonResponse -Context $context -StatusCode 404 -Payload @{ ok = $false; error = "Not found." }
      continue
    }

    $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
    $rawBody = $reader.ReadToEnd()
    $reader.Close()
    $payload = $rawBody | ConvertFrom-Json

    $to = [string]$payload.to
    $subject = [string]$payload.subject
    $body = [string]$payload.body
    $attachmentName = [string]$payload.attachmentName
    $attachmentBase64 = [string]$payload.attachmentBase64

    if ([string]::IsNullOrWhiteSpace($to)) {
      throw "Recipient email is required."
    }
    if ([string]::IsNullOrWhiteSpace($attachmentBase64)) {
      throw "Attachment data is required."
    }

    $attachmentPath = New-TemporaryAttachmentPath -Filename $attachmentName
    [System.IO.File]::WriteAllBytes($attachmentPath, [System.Convert]::FromBase64String($attachmentBase64))

    $outlook = New-Object -ComObject Outlook.Application
    $mailItem = $outlook.CreateItem(0)
    $mailItem.To = $to
    $mailItem.Subject = $subject
    $mailItem.Body = $body
    $mailItem.Attachments.Add($attachmentPath) | Out-Null
    $mailItem.Save()
    $mailItem.Display() | Out-Null

    Send-JsonResponse -Context $context -StatusCode 200 -Payload @{
      ok = $true
      attachmentPath = $attachmentPath
      to = $to
      subject = $subject
    }
  } catch {
    Send-JsonResponse -Context $context -StatusCode 500 -Payload @{
      ok = $false
      error = $_.Exception.Message
    }
  }
}
