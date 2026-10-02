<?php
/**
 * Categories and tags for the v2 engine: read, checked, written and
 * restored with the post, inside the same transaction.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * A post's terms are `{category: [{id, name}], post_tag: [...]}`, ordered by
 * term ID. A change names the whole set each changed taxonomy ends with:
 * existing terms by ID, and new ones by name, created when the approved
 * write is prepared.
 */
final class Post_Terms {

	public const TAXONOMIES = array( 'category', 'post_tag' );

	/**
	 * The taxonomies v2 can set on this post type, for the editor capability
	 * snapshot, or null when there are none.
	 *
	 * @return array{taxonomies: list<string>}|null
	 */
	public static function describe( string $post_type ): ?array {
		if ( 'post' !== $post_type ) {
			return null;
		}
		$taxonomies = array_values( array_filter( self::TAXONOMIES, static fn ( string $taxonomy ): bool => is_object_in_taxonomy( $post_type, $taxonomy ) ) );
		return array() === $taxonomies ? null : array( 'taxonomies' => $taxonomies );
	}

	/** @return array<string, list<array{id: int, name: string}>> */
	public static function read( int $post_id ): array {
		$terms = array();
		foreach ( self::TAXONOMIES as $taxonomy ) {
			$found              = wp_get_object_terms( $post_id, $taxonomy );
			$terms[ $taxonomy ] = is_array( $found ) ? self::refs( $found ) : array();
		}
		return $terms;
	}

	/** @param array<string, mixed> $terms */
	public static function hash( array $terms ): string {
		return hash( 'sha256', Runtime_Fingerprint::canonical_json( $terms ) );
	}

	public static function current_hash( int $post_id ): string {
		return self::hash( self::read( $post_id ) );
	}

	/**
	 * Checks a requested change, then makes any new terms it asked for, and
	 * returns the terms the post will end with and the change by term ID.
	 * Every existing term must exist in its taxonomy; the service user must be
	 * able to assign terms, and to create them for a new one; a post keeps at
	 * least one category. A new term whose name exists by now (a retry, or
	 * someone made it meanwhile) is that term, never a duplicate. Runs when the
	 * approved write is prepared, so nothing is created before approval.
	 *
	 * @param array<string, mixed> $changes  Requested sets, by taxonomy.
	 * @param int|null             $post_id  The post, or null for a new draft.
	 * @return array{after: array<string, list<array{id: int, name: string}>>, changes: array<string, list<array{id: int}>>, created: list<int>}|string
	 */
	public static function prepare( array $changes, ?int $post_id ) {
		if ( array() === $changes ) {
			return 'No categories or tags were requested.';
		}
		$after = null !== $post_id
			? self::read( $post_id )
			// A new post gets the default category from WordPress unless one is set.
			: array(
				'category' => self::refs( array_filter( array( get_term( (int) get_option( 'default_category' ), 'category' ) ) ) ),
				'post_tag' => array(),
			);
		// Check everything first, so a refused change creates nothing.
		$planned = array();
		foreach ( $changes as $taxonomy => $refs ) {
			if ( ! in_array( $taxonomy, self::TAXONOMIES, true ) || ! is_array( $refs ) ) {
				return 'Only categories and tags can be set.';
			}
			$object = get_taxonomy( $taxonomy );
			if ( ! $object instanceof \WP_Taxonomy || ! current_user_can( (string) ( $object->cap->assign_terms ?? 'edit_posts' ) ) ) {
				return "The SitePilot user can't assign {$taxonomy} terms.";
			}
			$terms     = array();
			$new_names = array();
			foreach ( $refs as $ref ) {
				if ( is_array( $ref ) && ! empty( $ref['new'] ) ) {
					$name = trim( sanitize_text_field( (string) ( $ref['name'] ?? '' ) ) );
					if ( '' === $name ) {
						return "A new {$taxonomy} term has no name.";
					}
					$existing = get_term_by( 'name', $name, $taxonomy );
					if ( $existing instanceof \WP_Term ) {
						$terms[ (int) $existing->term_id ] = $existing;
					} else {
						$new_names[ strtolower( $name ) ] = $name;
					}
					continue;
				}
				$term = get_term( absint( is_array( $ref ) ? ( $ref['id'] ?? 0 ) : 0 ), $taxonomy );
				if ( ! $term instanceof \WP_Term ) {
					return "A requested {$taxonomy} term doesn't exist.";
				}
				$terms[ (int) $term->term_id ] = $term;
			}
			if ( array() !== $new_names && ! current_user_can( (string) ( $object->cap->edit_terms ?? 'manage_categories' ) ) ) {
				return "The SitePilot user can't create {$taxonomy} terms.";
			}
			if ( 'category' === $taxonomy && array() === $terms && array() === $new_names ) {
				return 'A post keeps at least one category.';
			}
			$planned[ $taxonomy ] = array( 'terms' => $terms, 'new' => $new_names );
		}
		$created = array();
		$resolved = array();
		foreach ( $planned as $taxonomy => $plan ) {
			$terms = $plan['terms'];
			foreach ( $plan['new'] as $name ) {
				$inserted = wp_insert_term( $name, $taxonomy );
				$term_id  = is_wp_error( $inserted )
					// It exists after all: use it.
					? absint( 'term_exists' === $inserted->get_error_code() ? $inserted->get_error_data() : 0 )
					: absint( $inserted['term_id'] ?? 0 );
				$term = $term_id > 0 ? get_term( $term_id, $taxonomy ) : null;
				if ( ! $term instanceof \WP_Term ) {
					return "SitePilot couldn't create the {$taxonomy} term “{$name}”.";
				}
				if ( ! is_wp_error( $inserted ) ) {
					$created[] = $term_id;
				}
				$terms[ $term_id ] = $term;
			}
			ksort( $terms );
			$after[ $taxonomy ]    = self::refs( array_values( $terms ) );
			$resolved[ $taxonomy ] = array_map( static fn ( int $id ): array => array( 'id' => $id ), array_keys( $terms ) );
		}
		return array( 'after' => $after, 'changes' => $resolved, 'created' => $created );
	}

	/**
	 * Sets each changed taxonomy to its requested terms.
	 *
	 * @param array<string, mixed> $changes Requested sets, by taxonomy.
	 */
	public static function write( int $post_id, array $changes ): bool {
		foreach ( $changes as $taxonomy => $refs ) {
			$ids    = array_map( static fn ( $ref ): int => absint( is_array( $ref ) ? ( $ref['id'] ?? 0 ) : 0 ), (array) $refs );
			$result = wp_set_object_terms( $post_id, $ids, (string) $taxonomy, false );
			if ( is_wp_error( $result ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Puts back the terms a post had before a write.
	 *
	 * @param array<string, mixed> $before Terms from read().
	 */
	public static function restore( int $post_id, array $before ): bool {
		$current = self::read( $post_id );
		foreach ( self::TAXONOMIES as $taxonomy ) {
			$ids = self::ids( (array) ( $before[ $taxonomy ] ?? array() ) );
			if ( $ids === self::ids( $current[ $taxonomy ] ) ) {
				continue;
			}
			$result = wp_set_object_terms( $post_id, $ids, $taxonomy, false );
			if ( is_wp_error( $result ) || $ids !== self::ids( self::read( $post_id )[ $taxonomy ] ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * @param array<int, mixed> $refs Term refs.
	 * @return list<int> Their IDs, in order.
	 */
	private static function ids( array $refs ): array {
		$ids = array_map( static fn ( $ref ): int => absint( is_array( $ref ) ? ( $ref['id'] ?? 0 ) : 0 ), $refs );
		sort( $ids );
		return $ids;
	}

	/**
	 * @param array<int, mixed> $terms Terms from WordPress.
	 * @return list<array{id: int, name: string}>
	 */
	private static function refs( array $terms ): array {
		$refs = array();
		foreach ( $terms as $term ) {
			if ( $term instanceof \WP_Term ) {
				$refs[ (int) $term->term_id ] = array(
					'id'   => (int) $term->term_id,
					'name' => trim( html_entity_decode( (string) $term->name, ENT_QUOTES ) ),
				);
			}
		}
		ksort( $refs );
		return array_values( $refs );
	}
}
