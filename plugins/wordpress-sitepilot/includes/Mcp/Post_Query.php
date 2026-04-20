<?php
/**
 * Read-only post lookup helper for SitePilot MCP tools.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\Mcp;

/**
 * Finds posts by a constrained set of filters.
 */
final class Post_Query {

	/**
	 * @param array<string, mixed> $input Tool input.
	 * @return array<string, mixed>
	 */
	public static function find_posts( array $input ): array {
		$post_type = isset( $input['post_type'] ) ? sanitize_key( (string) $input['post_type'] ) : 'any';
		$status    = isset( $input['status'] ) ? sanitize_key( (string) $input['status'] ) : 'any';
		$slug      = isset( $input['slug'] ) ? sanitize_title( (string) $input['slug'] ) : '';
		$title     = isset( $input['title'] ) ? sanitize_text_field( (string) $input['title'] ) : '';
		$search    = isset( $input['search'] ) ? sanitize_text_field( (string) $input['search'] ) : '';
		$limit     = isset( $input['limit'] ) ? (int) $input['limit'] : 10;
		$limit     = max( 1, min( 20, $limit ) );

		if ( 'any' !== $post_type && ! post_type_exists( $post_type ) ) {
			return array(
				'ok'            => false,
				'total_matches' => 0,
				'truncated'     => false,
				'matches'       => array(),
				'error'         => 'invalid_post_type',
			);
		}

		$args = array(
			'post_type'           => 'any' === $post_type ? 'any' : $post_type,
			'post_status'         => 'any' === $status ? 'any' : $status,
			'posts_per_page'      => $limit,
			'orderby'             => 'modified',
			'order'               => 'DESC',
			'ignore_sticky_posts' => true,
			'no_found_rows'       => false,
		);

		if ( '' !== $slug ) {
			$args['post_name__in'] = array( $slug );
		}

		if ( '' !== $search ) {
			$args['s'] = $search;
		}

		$title_filter = null;
		if ( '' !== $title ) {
			global $wpdb;
			$title_filter = static function ( string $where ) use ( $wpdb, $title ): string {
				return $where . $wpdb->prepare( " AND {$wpdb->posts}.post_title = %s", $title );
			};
			add_filter( 'posts_where', $title_filter );
		}

		try {
			$query = new \WP_Query( $args );
		} finally {
			if ( null !== $title_filter ) {
				remove_filter( 'posts_where', $title_filter );
			}
		}

		$matches = array();
		foreach ( $query->posts as $post ) {
			if ( ! $post instanceof \WP_Post ) {
				continue;
			}

			$matches[] = array(
				'post_id'      => (int) $post->ID,
				'post_type'    => (string) $post->post_type,
				'post_status'  => (string) $post->post_status,
				'post_title'   => (string) get_the_title( $post ),
				'post_name'    => (string) $post->post_name,
				'modified_gmt' => (string) $post->post_modified_gmt,
			);
		}

		return array(
			'ok'            => true,
			'total_matches' => (int) $query->found_posts,
			'truncated'     => (int) $query->found_posts > count( $matches ),
			'matches'       => $matches,
		);
	}
}
