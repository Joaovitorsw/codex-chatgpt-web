# Native2 recovery before retry

On a Windows source checkout, the ChatGPT Web adapter runs
`scripts/recover-native-gateway.ps1` before returning a retryable
`native_connector_internal_error`. The script uses the existing DevSpace-only
startup flow and verifies the local native gateway health. The adapter bounds
recovery to 90 seconds and shares concurrent recovery attempts; the script also
serializes recovery across processes.

Retry is allowed only when no new native tool batch was dispatched and no active
or outstanding native calls exist. The adapter checks these conditions again
after recovery, including request cancellation. Failed recovery or a changed
dispatch state returns a non-retryable error. Confirmed results remain in the
existing conversation/retry flow; timeout and uncertain execution do not opt in
to this recovery path. The existing retry budget still applies.

The adapter signals the existing caller retry mechanism; it does not replay a
command inside the recovery script. This does not control autonomous tool retries
inside the remote ChatGPT service.

Packaged runtimes without the script and non-Windows hosts fail closed rather
than retry without verified recovery. Restart the source runtime after changing
the adapter to load the integration. The standalone `recuperar-native2.cmd` and
periodic watchdog remain available independently.
