package dev.agentx.phone

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler

/**
 * Chrome asks this service before it shows the phone app's notifications and
 * before it gives the page the location. Without the location handler Chrome
 * refuses navigator.geolocation in the Trusted Web Activity, so "Use where I
 * am now" on the Places card always reports the location as blocked (#684).
 * With it, Chrome reads the location through this app and its permission.
 */
class DelegationService : com.google.androidbrowserhelper.trusted.DelegationService() {
    override fun onCreate() {
        super.onCreate()
        registerExtraCommandHandler(LocationDelegationExtraCommandHandler())
    }
}
