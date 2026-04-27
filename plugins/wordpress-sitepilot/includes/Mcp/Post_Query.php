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
	private static function build_query_args( array $input ): array {
		$post_type = isset( $input['post_type'] ) ? sanitize_key( (string) $input['post_type'] ) : 'any';
		$status    = isset( $input['status'] ) ? sanitize_key( (string) $input['status'] ) : 'any';
		$slug      = isset( $input['slug'] ) ? sanitize_title( (string) $input['slug'] ) : '';
		$title     = isset( $input['title'] ) ? sanitize_text_field( (string) $input['title'] ) : '';
		$search    = isset( $input['search'] ) ? sanitize_text_field( (string) $input['search'] ) : '';
		$category  = isset( $input['category'] ) ? sanitize_title( (string) $input['category'] ) : '';
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

		if ( '' !== $category ) {
			$args['category_name'] = $category;
		}

		return array(
			'ok'    => true,
			'args'  => $args,
			'title' => $title,
		);
	}

	/**
	 * @param array<string, mixed> $input Tool input.
	 * @return array<string, mixed>
	 */
	public static function find_posts( array $input ): array {
		$query_config = self::build_query_args( $input );
		if ( empty( $query_config['ok'] ) ) {
			return $query_config;
		}

		$args  = $query_config['args'];
		$title = $query_config['title'];

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
				'post_date_gmt' => (string) $post->post_date_gmt,
				'modified_gmt' => (string) $post->post_modified_gmt,
				'permalink'    => (string) get_permalink( $post ),
			);
		}

		return array(
			'ok'            => true,
			'total_matches' => (int) $query->found_posts,
			'truncated'     => (int) $query->found_posts > count( $matches ),
			'matches'       => $matches,
		);
	}

	/**
	 * @param array<string, mixed> $input Tool input.
	 * @return array<string, mixed>
	 */
	public static function get_post( array $input ): array {
		$post_id = isset( $input['post_id'] ) ? (int) $input['post_id'] : 0;
		if ( $post_id > 0 ) {
			$post = get_post( $post_id );
			if ( ! $post instanceof \WP_Post ) {
				return array(
					'ok'    => false,
					'error' => 'post_not_found',
				);
			}

			return self::format_post_result( $post );
		}

		$lookup_input          = $input;
		$lookup_input['limit'] = 2;
		$lookup                = self::find_posts( $lookup_input );
		if ( empty( $lookup['ok'] ) ) {
			return $lookup;
		}

		$matches = isset( $lookup['matches'] ) && is_array( $lookup['matches'] ) ? $lookup['matches'] : array();
		if ( 0 === count( $matches ) ) {
			return array(
				'ok'    => false,
				'error' => 'post_not_found',
			);
		}

		if ( (int) $lookup['total_matches'] !== 1 || 1 !== count( $matches ) ) {
			return array(
				'ok'            => false,
				'error'         => 'post_ambiguous',
				'total_matches' => (int) $lookup['total_matches'],
				'matches'       => $matches,
			);
		}

		$resolved_post_id = isset( $matches[0]['post_id'] ) ? (int) $matches[0]['post_id'] : 0;
		$post             = $resolved_post_id > 0 ? get_post( $resolved_post_id ) : null;
		if ( ! $post instanceof \WP_Post ) {
			return array(
				'ok'    => false,
				'error' => 'post_not_found',
			);
		}

		return self::format_post_result( $post );
	}

	/**
	 * @param \WP_Post $post WordPress post object.
	 * @return array<string, mixed>
	 */
	private static function format_post_result( \WP_Post $post ): array {
		$category_names = array_values(
			array_filter(
				array_map(
					static function ( $term ) {
						return $term instanceof \WP_Term ? (string) $term->slug : null;
					},
					get_the_category( $post->ID )
				)
			)
		);

		return array(
			'ok'             => true,
			'post_id'        => (int) $post->ID,
			'post_type'      => (string) $post->post_type,
			'post_status'    => (string) $post->post_status,
			'post_title'     => (string) get_the_title( $post ),
			'post_name'      => (string) $post->post_name,
			'post_excerpt'   => (string) $post->post_excerpt,
			'post_content'   => (string) $post->post_content,
			'post_date_gmt'  => (string) $post->post_date_gmt,
			'modified_gmt'   => (string) $post->post_modified_gmt,
			'permalink'      => (string) get_permalink( $post ),
			'category_slugs' => $category_names,
		);
	}
}
