<?php
/**
 * Signed approval proofs: the site checks that a person approved each write.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

use SitePilot\Errors\Error_Contract;
use SitePilot\Registration\Store;
use SitePilot\Security\Nonce_Ledger;
use SitePilot\Security\Signed_Request_Verifier;

/**
 * A registered client can add an Ed25519 approval key, separate from its
 * request secret. From then on every v2 write from that client needs an
 * approval signed with the key, bound to the exact candidate, valid for at
 * most 30 minutes and used by one execution only. Sites without a key keep
 * working without proofs.
 */
final class Approval_Proof {

	public const FEATURE          = 'approval_proof_v1';
	public const KEY_REQUEST      = 'sitepilot.approval-key-request/v1';
	public const KEY_RESPONSE     = 'sitepilot.approval-key/v1';
	public const PROOF_SCHEMA     = 'sitepilot.approval-proof/v1';
	public const STATEMENT_SCHEMA = 'sitepilot.approval-statement/v1';
	public const AUDIENCE         = 'sitepilot.v2.write';

	/** The longest an approval may stay valid, in seconds. */
	public const MAX_TTL = 1800;

	/** How far ahead of this server's clock an approval time may be. */
	public const CLOCK_SKEW = 300;

	public const USE_PREFIX = 'sitepilot_v2_approval_use_';

	public static function register_hooks(): void {
		add_action( Nonce_Ledger::CLEANUP_HOOK, array( self::class, 'delete_expired' ) );
	}

	/**
	 * Registers or replaces the calling client's approval key.
	 *
	 * @param array<string, mixed> $params Request body.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function register_key( array $params ) {
		$site_id = Signed_Request_Verifier::get_authenticated_site_id();
		if ( self::KEY_REQUEST !== ( $params['schemaVersion'] ?? null ) || 'ed25519' !== ( $params['algorithm'] ?? null ) ) {
			return self::error( 'schema_invalid', __( 'The approval key request is invalid.', 'sitepilot' ), 400 );
		}
		$public_key = self::decode( $params['publicKey'] ?? null, SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES );
		$key_id     = is_string( $params['keyId'] ?? null ) ? $params['keyId'] : '';
		if ( null === $public_key || ! hash_equals( self::key_id( $public_key ), $key_id ) ) {
			return self::error( 'schema_invalid', __( 'The approval key or its ID is invalid.', 'sitepilot' ), 400 );
		}
		$record = Store::get_row( $site_id );
		if ( null === $record ) {
			return self::error( 'permission_denied', __( 'This SitePilot client is no longer registered.', 'sitepilot' ), 403 );
		}
		$registered_at            = time();
		$record['approval_key']   = array(
			'key_id'        => $key_id,
			'public_key'    => base64_encode( $public_key ),
			'registered_at' => $registered_at,
		);
		Store::save_site( $site_id, $record );
		return array(
			'schemaVersion' => self::KEY_RESPONSE,
			'keyId'         => $key_id,
			'algorithm'     => 'ed25519',
			'registeredAt'  => gmdate( 'c', $registered_at ),
			'required'      => true,
		);
	}

	/** Whether writes from this client need a proof. */
	public static function required( string $site_id ): bool {
		return null !== self::key_for_site( $site_id );
	}

	/**
	 * @return array{key_id: string, public_key: string}|null Public key as raw bytes.
	 */
	public static function key_for_site( string $site_id ): ?array {
		$row = Store::get_row( $site_id );
		$key = is_array( $row['approval_key'] ?? null ) ? $row['approval_key'] : null;
		if ( null === $key ) {
			return null;
		}
		$public_key = self::decode( $key['public_key'] ?? null, SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES );
		$key_id     = (string) ( $key['key_id'] ?? '' );
		return null !== $public_key && hash_equals( self::key_id( $public_key ), $key_id )
			? array( 'key_id' => $key_id, 'public_key' => $public_key )
			: null;
	}

	/**
	 * Checks an approval's proof and claims the approval for this execution.
	 * Returns null when the approval may be used: it carries a valid proof,
	 * or the client has no approval key.
	 *
	 * @param array<string, mixed> $approval Approval, as sent.
	 */
	public static function verify( string $site_id, array $approval, string $execution_id ): ?\WP_Error {
		$key = self::key_for_site( $site_id );
		if ( null === $key ) {
			return null;
		}
		$proof = is_array( $approval['proof'] ?? null ) ? $approval['proof'] : null;
		if ( null === $proof ) {
			return self::refuse( __( 'This site only accepts changes with a signed approval. Approve the change again in SitePilot.', 'sitepilot' ), 'proof_missing' );
		}
		if ( self::PROOF_SCHEMA !== ( $proof['schemaVersion'] ?? null ) || 'ed25519' !== ( $proof['algorithm'] ?? null ) ) {
			return self::refuse( __( 'The approval proof is invalid.', 'sitepilot' ), 'proof_invalid' );
		}
		if ( ! is_string( $proof['keyId'] ?? null ) || ! hash_equals( $key['key_id'], $proof['keyId'] ) ) {
			return self::refuse( __( "The approval was signed with a key this site doesn't have. Approve the change again in SitePilot.", 'sitepilot' ), 'unknown_key' );
		}
		$binding = is_array( $approval['binding'] ?? null ) ? $approval['binding'] : array();
		if ( ! hash_equals( $site_id, (string) ( $binding['siteId'] ?? '' ) ) ) {
			return self::refuse( __( 'The approval is for another site.', 'sitepilot' ), 'wrong_site' );
		}
		$approved_at = strtotime( (string) ( $approval['approvedAt'] ?? '' ) );
		$expires_at  = strtotime( (string) ( $approval['expiresAt'] ?? '' ) );
		$now         = time();
		if ( false === $approved_at || false === $expires_at || $approved_at > $now + self::CLOCK_SKEW || $expires_at - $approved_at > self::MAX_TTL + 5 ) {
			return self::refuse( __( 'The approval times are invalid: an approval may last at most 30 minutes.', 'sitepilot' ), 'invalid_times' );
		}
		if ( $expires_at <= $now ) {
			return Error_Contract::error( 'sitepilot_v2_', 'approval_expired', __( 'The approval has expired. Approve the change again in SitePilot.', 'sitepilot' ), 409 );
		}
		$signature = self::decode( $proof['signature'] ?? null, SODIUM_CRYPTO_SIGN_BYTES );
		$statement = self::statement( $approval, $key['key_id'] );
		if ( null === $signature || null === $statement || ! sodium_crypto_sign_verify_detached( $signature, $statement, $key['public_key'] ) ) {
			return self::refuse( __( "The approval's signature doesn't match this change.", 'sitepilot' ), 'signature_invalid' );
		}
		return self::claim( $site_id, (string) $approval['approvalId'], $execution_id, $expires_at );
	}

	/**
	 * The bytes an approval proof signs: canonical JSON, identical to the
	 * desktop's canonicalGutenbergV2Json().
	 *
	 * @param array<string, mixed> $approval Approval.
	 */
	public static function statement( array $approval, string $key_id ): ?string {
		$binding = is_array( $approval['binding'] ?? null ) ? $approval['binding'] : null;
		foreach ( array( 'approvalId', 'approverId', 'approvedAt', 'expiresAt' ) as $field ) {
			if ( ! is_string( $approval[ $field ] ?? null ) ) {
				return null;
			}
		}
		if ( null === $binding || ! is_string( $binding['siteId'] ?? null ) || ! is_string( $binding['candidateId'] ?? null ) ) {
			return null;
		}
		return Runtime_Fingerprint::canonical_json(
			array(
				'schemaVersion' => self::STATEMENT_SCHEMA,
				'audience'      => self::AUDIENCE,
				'siteId'        => $binding['siteId'],
				'candidateId'   => $binding['candidateId'],
				'approvalId'    => $approval['approvalId'],
				'approverId'    => $approval['approverId'],
				'approvedAt'    => $approval['approvedAt'],
				'expiresAt'     => $approval['expiresAt'],
				'bindingHash'   => hash( 'sha256', Runtime_Fingerprint::canonical_json( $binding, true ) ),
				'keyId'         => $key_id,
			),
			true
		);
	}

	/** Key IDs are derived from the key, so a key can't claim another's ID. */
	public static function key_id( string $public_key ): string {
		return 'ak_' . substr( hash( 'sha256', $public_key ), 0, 32 );
	}

	/**
	 * Deletes use records whose approval has expired: a replay of those is
	 * refused by the expiry check anyway.
	 */
	public static function delete_expired(): void {
		global $wpdb;
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT 500",
				$wpdb->esc_like( self::USE_PREFIX ) . '%'
			)
		);
		foreach ( is_array( $rows ) ? $rows : array() as $row ) {
			$expires = (int) strtok( (string) $row->option_value, '|' );
			if ( $expires < time() ) {
				delete_option( (string) $row->option_name );
			}
		}
	}

	/** One execution per approval. A retry of the same execution passes. */
	private static function claim( string $site_id, string $approval_id, string $execution_id, int $expires_at ): ?\WP_Error {
		$name  = self::USE_PREFIX . hash( 'sha256', $site_id . "\n" . $approval_id );
		$value = $expires_at . '|' . $execution_id;
		if ( add_option( $name, $value, '', false ) ) {
			return null;
		}
		$stored = (string) get_option( $name, '' );
		$parts  = explode( '|', $stored, 2 );
		if ( isset( $parts[1] ) && hash_equals( $parts[1], $execution_id ) ) {
			return null;
		}
		return self::refuse( __( 'This approval was already used for another change. Approve the change again in SitePilot.', 'sitepilot' ), 'approval_reused' );
	}

	private static function decode( $value, int $length ): ?string {
		if ( ! is_string( $value ) ) {
			return null;
		}
		$decoded = base64_decode( $value, true );
		return is_string( $decoded ) && strlen( $decoded ) === $length ? $decoded : null;
	}

	public static function refuse( string $message, string $reason ): \WP_Error {
		return Error_Contract::custom( 'sitepilot_v2_approval_invalid', 'approval_invalid', $message, 403, 'approval_required', false, array( 'reason' => $reason ) );
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return Error_Contract::error( 'sitepilot_v2_', $code, $message, $status );
	}
}
