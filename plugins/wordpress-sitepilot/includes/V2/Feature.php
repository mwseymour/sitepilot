<?php
/**
 * SitePilot v2 feature gate.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * The v2 native editor runtime is SitePilot's only content engine. A site stops
 * SitePilot changing content by defining SITEPILOT_V2_ENABLED as the boolean
 * false. Lookups still work.
 */
final class Feature {

	public const BRIDGE_VERSION = '2.0.0-alpha.2';

	public static function enabled(): bool {
		return ! ( defined( 'SITEPILOT_V2_ENABLED' ) && false === SITEPILOT_V2_ENABLED );
	}

	public static function disabled_error(): \WP_Error {
		return new \WP_Error(
			'sitepilot_v2_disabled',
			__( 'SitePilot changes are turned off on this site (SITEPILOT_V2_ENABLED is false).', 'sitepilot' ),
			array( 'status' => 503 )
		);
	}
}
