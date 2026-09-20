<#
.SYNOPSIS
  Run a local PostgreSQL cluster for development on a machine without Docker.

.DESCRIPTION
  docker-compose.yml is the supported development path and the one production
  mirrors. This script exists for Windows machines where Docker Desktop is not
  installed: it drives a PostgreSQL server from a conda environment against a
  project-local data directory (.pgdata), which is gitignored.

  One-time setup:
    conda create -y -n cpga-pg -c conda-forge postgresql
    .\scripts\dev-postgres.ps1 init

  Daily use:
    .\scripts\dev-postgres.ps1 start
    .\scripts\dev-postgres.ps1 status
    .\scripts\dev-postgres.ps1 stop

  The cluster trusts local connections and holds no production data. Never
  point a deployed environment at it.

.PARAMETER Command
  init | start | stop | status | destroy | psql
#>

param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status', 'destroy', 'psql')]
  [string]$Command = 'status',

  [int]$Port = 5432,
  [string]$CondaEnv = 'cpga-pg'
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PgData = Join-Path $ProjectRoot '.pgdata'
$PgBin = Join-Path $env:USERPROFILE "miniconda3\envs\$CondaEnv\Library\bin"

if (-not (Test-Path $PgBin)) {
  $PgBin = Join-Path $env:USERPROFILE "anaconda3\envs\$CondaEnv\Library\bin"
}

function Assert-Binaries {
  if (-not (Test-Path (Join-Path $PgBin 'pg_ctl.exe'))) {
    throw "PostgreSQL binaries not found in $PgBin. Run: conda create -y -n $CondaEnv -c conda-forge postgresql"
  }
}

function Invoke-Pg([string]$exe, [string[]]$pgArgs) {
  & (Join-Path $PgBin "$exe.exe") @pgArgs
}

switch ($Command) {
  'init' {
    Assert-Binaries
    if (Test-Path $PgData) {
      throw "$PgData already exists. Run 'destroy' first if you really want to recreate it."
    }
    Invoke-Pg 'initdb' @('-D', $PgData, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C')
    Invoke-Pg 'pg_ctl' @('-D', $PgData, '-l', (Join-Path $PgData 'server.log'), '-o', "-p $Port -c listen_addresses=127.0.0.1", 'start')
    Start-Sleep -Seconds 3
    foreach ($dbName in @('gateway', 'gateway_shadow', 'gateway_test')) {
      Invoke-Pg 'psql' @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-c', "CREATE DATABASE $dbName;")
    }
    Write-Host "Cluster ready. DATABASE_URL=postgresql://postgres@127.0.0.1:$Port/gateway?schema=public"
  }

  'start' {
    Assert-Binaries
    if (-not (Test-Path $PgData)) { throw "No cluster at $PgData. Run 'init' first." }
    Invoke-Pg 'pg_ctl' @('-D', $PgData, '-l', (Join-Path $PgData 'server.log'), '-o', "-p $Port -c listen_addresses=127.0.0.1", 'start')
  }

  'stop' {
    Assert-Binaries
    Invoke-Pg 'pg_ctl' @('-D', $PgData, '-m', 'fast', 'stop')
  }

  'status' {
    Assert-Binaries
    Invoke-Pg 'pg_ctl' @('-D', $PgData, 'status')
  }

  'psql' {
    Assert-Binaries
    Invoke-Pg 'psql' @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'gateway')
  }

  'destroy' {
    Assert-Binaries
    try { Invoke-Pg 'pg_ctl' @('-D', $PgData, '-m', 'immediate', 'stop') } catch { }
    Remove-Item -Recurse -Force $PgData
    Write-Host "Removed $PgData"
  }
}
