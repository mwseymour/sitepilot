<?php
/**
 * Plugin-neutral SEO fields, mapped to the active SEO plugin's post meta.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Seo;

/**
 * One place that knows how SEO plugins store their per-post fields. The v1
 * `set-post-seo-meta` ability, v2 commits and read-back all go through it.
 *
 * Neutral fields: title, description, focusKeyphrase, canonical, indexing
 * (default | noindex | index), socialTitle, socialDescription. An empty
 * string (or `default` for indexing) clears the field so the plugin's own
 * default applies. Yoast SEO is supported first; its `%%variables%%` are
 * stored as written.
 */
final class Seo_Adapter {

	public const FIELDS = array( 'title', 'description', 'focusKeyphrase', 'canonical', 'indexing', 'socialTitle', 'socialDescription' );

	private const YOAST_META = array(
		'title'             => '_yoast_wpseo_title',
		'description'       => '_yoast_wpseo_metadesc',
		'focusKeyphrase'    => '_yoast_wpseo_focuskw',
		'canonical'         => '_yoast_wpseo_canonical',
		'indexing'          => '_yoast_wpseo_meta-robots-noindex',
		'socialTitle'       => '_yoast_wpseo_opengraph-title',
		'socialDescription' => '_yoast_wpseo_opengraph-description',
	);

	/** Yoast stores indexing as 0 (post type default), 1 (noindex) or 2 (index). */
	private const YOAST_INDEXING = array(
		'default' => '0',
		'noindex' => '1',
		'index'   => '2',
	);

	private const MAX_LENGTH = array(
		'title'             => 300,
		'description'       => 1000,
		'focusKeyphrase'    => 200,
		'canonical'         => 2000,
		'socialTitle'       => 300,
		'socialDescription' => 1000,
	);

	/**
	 * The active SEO plugin this adapter can write, or null.
	 *
	 * @return array{plugin: string, name: string, version: string, fields: array<int, string>}|null
	 */
	public static function describe(): ?array {
		if ( ! self::yoast_active() ) {
			return null;
		}
		return array(
			'plugin'  => 'yoast',
			'name'    => 'Yoast SEO',
			'version' => defined( 'WPSEO_VERSION' ) ? (string) constant( 'WPSEO_VERSION' ) : '',
			'fields'  => self::FIELDS,
		);
	}

	public static function active(): bool {
		return null !== self::describe();
	}

	private static function yoast_active(): bool {
		return defined( 'WPSEO_VERSION' ) || class_exists( '\WPSEO_Meta' );
	}

	/** @return array<string, string> Neutral field => meta key. */
	public static function meta_keys(): array {
		return self::yoast_active() ? self::YOAST_META : array();
	}

	/**
	 * The post's current SEO values, every field present.
	 *
	 * @return array<string, string>|null
	 */
	public static function read( int $post_id ): ?array {
		if ( ! self::active() ) {
			return null;
		}
		$values = array();
		foreach ( self::meta_keys() as $field => $key ) {
			$raw = (string) get_post_meta( $post_id, $key, true );
			$values[ $field ] = 'indexing' === $field ? self::indexing_from_meta( $raw ) : $raw;
		}
		return $values;
	}

	public static function hash( array $values ): string {
		return hash( 'sha256', \SitePilot\V2\Runtime_Fingerprint::canonical_json( $values, true ) );
	}

	/** Hash of the post's current SEO values, or '' without a supported plugin. */
	public static function current_hash( int $post_id ): string {
		$values = self::read( $post_id );
		return null === $values ? '' : self::hash( $values );
	}

	/**
	 * Exact stored meta for every field (null when absent), so a rollback can
	 * put back precisely what was there, including absence.
	 *
	 * @return array<string, string|null>
	 */
	public static function raw_meta( int $post_id ): array {
		$raw = array();
		foreach ( self::meta_keys() as $key ) {
			$raw[ $key ] = metadata_exists( 'post', $post_id, $key ) ? (string) get_post_meta( $post_id, $key, true ) : null;
		}
		return $raw;
	}

	/**
	 * Checks requested changes. Values must already be in the form WordPress
	 * will store, so the approved value is exactly the written value.
	 *
	 * @param mixed $changes Requested neutral changes.
	 */
	public static function validate( $changes ): ?string {
		if ( ! self::active() ) {
			return 'This site has no supported SEO plugin (Yoast SEO), so SEO fields cannot be changed.';
		}
		if ( ! is_array( $changes ) || empty( $changes ) || array_is_list( $changes ) ) {
			return 'SEO changes must name at least one field.';
		}
		foreach ( $changes as $field => $value ) {
			if ( ! in_array( $field, self::FIELDS, true ) ) {
				return "SEO field {$field} is not supported.";
			}
			if ( ! is_string( $value ) ) {
				return "SEO field {$field} must be text.";
			}
			if ( 'indexing' === $field ) {
				if ( ! array_key_exists( $value, self::YOAST_INDEXING ) ) {
					return 'SEO indexing must be default, noindex or index.';
				}
				continue;
			}
			if ( strlen( $value ) > self::MAX_LENGTH[ $field ] ) {
				return "SEO field {$field} is too long.";
			}
			if ( self::normalize( $field, $value ) !== $value ) {
				return 'canonical' === $field
					? 'The canonical URL must be a plain http(s) URL.'
					: "SEO field {$field} contains markup or line breaks that WordPress would remove.";
			}
		}
		return null;
	}

	/** The value as WordPress would store it for this field. */
	public static function normalize( string $field, string $value ): string {
		if ( 'canonical' === $field ) {
			if ( '' === $value ) {
				return '';
			}
			return preg_match( '#^https?://#i', $value ) ? esc_url_raw( $value, array( 'http', 'https' ) ) : '';
		}
		if ( 'indexing' === $field ) {
			return $value;
		}
		return sanitize_text_field( $value );
	}

	/**
	 * Writes the changes. An empty value (or indexing `default`) deletes the
	 * meta so the plugin default applies.
	 *
	 * @param array<string, string> $changes Validated neutral changes.
	 */
	public static function write( int $post_id, array $changes ): bool {
		$keys = self::meta_keys();
		foreach ( $changes as $field => $value ) {
			$key    = $keys[ $field ] ?? null;
			$stored = 'indexing' === $field ? self::YOAST_INDEXING[ $value ] : $value;
			if ( null === $key ) {
				return false;
			}
			if ( '' === $stored || ( 'indexing' === $field && '0' === $stored ) ) {
				delete_post_meta( $post_id, $key );
				if ( metadata_exists( 'post', $post_id, $key ) ) {
					return false;
				}
				continue;
			}
			update_post_meta( $post_id, $key, wp_slash( $stored ) );
			if ( (string) get_post_meta( $post_id, $key, true ) !== $stored ) {
				return false;
			}
		}
		return true;
	}

	/** @param array<string, string|null> $raw Meta captured by raw_meta(). */
	public static function restore( int $post_id, array $raw ): bool {
		foreach ( $raw as $key => $value ) {
			if ( ! in_array( $key, self::meta_keys(), true ) ) {
				continue;
			}
			if ( null === $value ) {
				delete_post_meta( $post_id, $key );
			} else {
				update_post_meta( $post_id, $key, wp_slash( $value ) );
			}
		}
		return self::raw_meta( $post_id ) === $raw;
	}

	private static function indexing_from_meta( string $raw ): string {
		$flipped = array_flip( self::YOAST_INDEXING );
		return $flipped[ $raw ] ?? 'default';
	}
}
