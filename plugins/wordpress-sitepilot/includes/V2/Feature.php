<?php
/**
 * SitePilot v2 feature gate.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * The v2 native editor runtime is the default content engine. A site can opt
 * out by defining SITEPILOT_V2_ENABLED as the boolean false.
 */
final class Feature {

	public const BRIDGE_VERSION = '2.0.0-alpha.2';

	public static function enabled(): bool {
		return ! ( defined( 'SITEPILOT_V2_ENABLED' ) && false === SITEPILOT_V2_ENABLED );
	}

	public static function disabled_error(): \WP_Error {
		return new \WP_Error(
			'sitepilot_v2_disabled',
			__( 'SitePilot v2 is disabled on this site (SITEPILOT_V2_ENABLED is false).', 'sitepilot' ),
			array( 'status' => 503 )
		);
	}
}
