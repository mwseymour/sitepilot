<?php
/**
 * Read-only term lookup for SitePilot MCP tools.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

/**
 * Lists the terms of a public taxonomy: categories, tags and the like.
 */
final class Term_Query {

	/**
	 * @param array<string, mixed> $input Tool input.
	 * @return array<string, mixed>
	 */
	public static function list_terms( array $input ): array {
		$taxonomy = isset( $input['taxonomy'] ) ? sanitize_key( (string) $input['taxonomy'] ) : 'category';
		$search   = isset( $input['search'] ) ? sanitize_text_field( (string) $input['search'] ) : '';
		$limit    = isset( $input['limit'] ) ? max( 1, min( 100, (int) $input['limit'] ) ) : 50;

		$object = get_taxonomy( $taxonomy );
		// Private taxonomies (nav menus, block patterns and so on) aren't content.
		if ( ! $object instanceof \WP_Taxonomy || ! $object->public ) {
			return array(
				'ok'            => false,
				'total_matches' => 0,
				'truncated'     => false,
				'terms'         => array(),
				'error'         => 'invalid_taxonomy',
			);
		}

		$args = array(
			'taxonomy'   => $taxonomy,
			'hide_empty' => false,
			'orderby'    => 'name',
			'order'      => 'ASC',
		);
		if ( '' !== $search ) {
			$args['search'] = $search;
		}
		if ( isset( $input['parent'] ) && $object->hierarchical ) {
			$args['parent'] = max( 0, (int) $input['parent'] );
		}

		$total = wp_count_terms( $args );
		$terms = get_terms( array_merge( $args, array( 'number' => $limit ) ) );
		if ( is_wp_error( $total ) || is_wp_error( $terms ) ) {
			return array(
				'ok'            => false,
				'total_matches' => 0,
				'truncated'     => false,
				'terms'         => array(),
				'error'         => 'terms_unavailable',
			);
		}

		$listed = array();
		foreach ( $terms as $term ) {
			if ( ! $term instanceof \WP_Term ) {
				continue;
			}
			$listed[] = array(
				'term_id' => (int) $term->term_id,
				'slug'    => (string) $term->slug,
				'name'    => html_entity_decode( (string) $term->name, ENT_QUOTES ),
				'parent'  => (int) $term->parent,
				// Published posts only, as WordPress counts them.
				'count'   => (int) $term->count,
			);
		}

		return array(
			'ok'            => true,
			'taxonomy'      => $taxonomy,
			'hierarchical'  => (bool) $object->hierarchical,
			'total_matches' => (int) $total,
			'truncated'     => (int) $total > count( $listed ),
			'terms'         => $listed,
		);
	}
}
