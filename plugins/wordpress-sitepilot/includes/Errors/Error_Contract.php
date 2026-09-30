<?php
/**
 * sitepilot.error/v1 on the plugin side.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Errors;

/**
 * Builds every SitePilot WP_Error with the same data: the code, a cause, whether
 * a retry is safe and optional details. The desktop reads these fields; codes
 * are for machines and messages stay plain language.
 *
 * Keep the table in step with KNOWN_ERROR_CODES in packages/contracts/src/errors.ts.
 */
final class Error_Contract {

	/** Advertised in /protocol so the desktop knows the fields are there. */
	public const FEATURE = 'error_contract_v1';

	/** @var array<string, array{0: string, 1: bool}> Code => [cause, retry_ok]. */
	private const CLASSIFICATION = array(
		'schema_invalid'            => array( 'invalid_input', false ),
		'request_too_large'         => array( 'invalid_input', false ),
		'invalid_block_markup'      => array( 'invalid_input', false ),
		'invalid_nesting'           => array( 'invalid_input', false ),
		'content_loss'              => array( 'invalid_input', false ),
		'invalid_session_request'   => array( 'invalid_input', false ),
		'invalid_json'              => array( 'invalid_input', false ),
		'invalid_payload'           => array( 'invalid_input', false ),
		'invalid_environment'       => array( 'invalid_input', false ),
		'invalid_secret'            => array( 'invalid_input', false ),
		'invalid_wordpress_user'    => array( 'invalid_input', false ),
		'wordpress_user_required'   => array( 'invalid_input', false ),
		'unregistered_block'        => array( 'not_supported', false ),
		'disallowed_block'          => array( 'not_supported', false ),
		'unsupported_v2_block'      => array( 'not_supported', false ),
		'v2_disabled'               => array( 'not_supported', false ),
		'protocol_mismatch'         => array( 'not_supported', false ),
		'stale_source'              => array( 'stale', false ),
		'runtime_changed'           => array( 'stale', false ),
		'idempotency_conflict'      => array( 'conflict', false ),
		'prepared_commit_changed'   => array( 'conflict', false ),
		'rollback_conflict'         => array( 'conflict', false ),
		'media_changed'             => array( 'conflict', false ),
		'site_exists'               => array( 'conflict', false ),
		'content_changed'           => array( 'wp_core', false ),
		'persisted_content_invalid' => array( 'wp_core', false ),
		'verification_failed'       => array( 'wp_core', false ),
		'approval_invalid'          => array( 'approval_required', false ),
		'approval_expired'          => array( 'approval_required', false ),
		'permission_denied'         => array( 'capability', false ),
		'read_only'                 => array( 'capability', false ),
		'invalid_bootstrap'         => array( 'auth', false ),
		'invalid_code'              => array( 'auth', false ),
		'prepared_commit_missing'   => array( 'not_found', false ),
		'post_not_found'            => array( 'not_found', false ),
		'editor_unavailable'        => array( 'host_environment', true ),
		'conditional_commit_failed' => array( 'internal', true ),
		'render_failed'             => array( 'render_failed', false ),
		'rollback_failed'           => array( 'internal', false ),
	);

	/**
	 * @param string               $prefix  Code prefix, for example 'sitepilot_v2_'.
	 * @param array<string, mixed> $details Extra fields for the desktop, never secrets.
	 */
	public static function error( string $prefix, string $code, string $message, int $status, array $details = array(), ?string $auth_reason = null ): \WP_Error {
		[ $cause, $retry_ok ] = self::classify( $code );
		$data                 = array(
			'status'   => $status,
			'code'     => $code,
			'cause'    => null !== $auth_reason ? 'auth' : $cause,
			'retry_ok' => $retry_ok,
		);
		if ( array() !== $details ) {
			$data['details'] = $details;
		}
		if ( null !== $auth_reason ) {
			$data['auth'] = array( 'reason' => $auth_reason );
		}
		return new \WP_Error( $prefix . $code, $message, $data );
	}

	/**
	 * For an error whose cause or retry flag differs from its code's usual
	 * one, such as a permanent refusal sent under a retryable code.
	 *
	 * @param array<string, mixed> $details Extra fields for the desktop, never secrets.
	 */
	public static function custom( string $wp_code, string $code, string $message, int $status, string $cause, bool $retry_ok, array $details = array() ): \WP_Error {
		$data = array(
			'status'   => $status,
			'code'     => $code,
			'cause'    => $cause,
			'retry_ok' => $retry_ok,
		);
		if ( array() !== $details ) {
			$data['details'] = $details;
		}
		return new \WP_Error( $wp_code, $message, $data );
	}

	/**
	 * The code a transaction threw as its exception message, when it's a known
	 * one. Anything else, such as a PHP error's message, becomes the fallback.
	 */
	public static function code_from_exception( \Throwable $error, string $fallback ): string {
		$message = $error->getMessage();
		return isset( self::CLASSIFICATION[ $message ] ) ? $message : $fallback;
	}

	/** An HTTP status that fits a code's cause, for places that had one status for everything. */
	public static function status_for( string $code, int $default ): int {
		$by_cause = array(
			'invalid_input'     => 400,
			'auth'              => 401,
			'capability'        => 403,
			'not_found'         => 404,
			'stale'             => 409,
			'conflict'          => 409,
			'approval_required' => 409,
			'not_supported'     => 422,
		);
		return $by_cause[ self::classify( $code )[0] ] ?? $default;
	}

	/** @return array{0: string, 1: bool} Cause and retry flag; unknown codes are never retryable. */
	public static function classify( string $code ): array {
		return self::CLASSIFICATION[ $code ] ?? array( 'internal', false );
	}
}
