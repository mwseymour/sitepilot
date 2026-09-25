<?php
/**
 * ACF block discovery, data validation and per-site fixture records.
 *
 * @package SitePilot
 */

declare( strict_types = 1 );

namespace SitePilot\V2;

/**
 * Describes every registered `acf/*` block with all of its fields, and keeps
 * the per-site record of which blocks passed a native save-and-reopen test.
 *
 * A block becomes authorable only while its fixture record matches the
 * current field schema and ACF version. Until then v2 keeps it untouched.
 */
final class Acf_Blocks {

	public const FIXTURES_OPTION = 'sitepilot_v2_block_fixtures';

	/** Field types whose values v2 can write into block data. */
	public const VALUE_TYPES = array(
		'text',
		'textarea',
		'wysiwyg',
		'number',
		'range',
		'email',
		'url',
		'select',
		'radio',
		'button_group',
		'checkbox',
		'true_false',
		'link',
		'image',
		'file',
		'repeater',
		'group',
		'flexible_content',
		'post_object',
		'page_link',
		'relationship',
		'color_picker',
		'date_picker',
		'date_time_picker',
		'time_picker',
		'oembed',
	);

	/** Field types that hold no value. */
	private const LAYOUT_TYPES = array( 'message', 'tab', 'accordion' );

	/** @var array<string, array<string, mixed>>|null */
	private static ?array $definitions = null;

	public static function reset_cache(): void {
		self::$definitions = null;
	}

	public static function available(): bool {
		return function_exists( 'acf_get_field_groups' ) && function_exists( 'acf_get_fields' );
	}

	public static function acf_version(): string {
		if ( defined( 'ACF_VERSION' ) ) {
			return (string) constant( 'ACF_VERSION' );
		}
		return '';
	}

	/**
	 * Every ACF block on this site, keyed by block name.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	public static function definitions(): array {
		if ( null !== self::$definitions ) {
			return self::$definitions;
		}
		$definitions = array();
		if ( self::available() ) {
			foreach ( self::block_types() as $name => $block ) {
				$definitions[ $name ] = self::describe_block( $name, $block );
			}
		}
		ksort( $definitions, SORT_STRING );
		self::$definitions = $definitions;
		return $definitions;
	}

	/** @return array<string, mixed>|null */
	public static function definition( string $name ): ?array {
		return self::definitions()[ $name ] ?? null;
	}

	public static function is_acf_block( string $name ): bool {
		return str_starts_with( $name, 'acf/' );
	}

	/**
	 * ACF block settings keyed by name, from ACF when it can list them and
	 * otherwise from the block registry.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function block_types(): array {
		$types = array();
		if ( function_exists( 'acf_get_block_types' ) ) {
			foreach ( (array) acf_get_block_types() as $name => $block ) {
				if ( is_string( $name ) && self::is_acf_block( $name ) && is_array( $block ) ) {
					$types[ $name ] = $block;
				}
			}
		}
		if ( class_exists( '\WP_Block_Type_Registry' ) ) {
			foreach ( \WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $type ) {
				if ( ! is_string( $name ) || ! self::is_acf_block( $name ) ) {
					continue;
				}
				$registered = array(
					'title'          => (string) ( $type->title ?? '' ),
					'description'    => (string) ( $type->description ?? '' ),
					'category'       => (string) ( $type->category ?? '' ),
					'supports'       => is_array( $type->supports ?? null ) ? $type->supports : array(),
					'parent'         => is_array( $type->parent ?? null ) ? $type->parent : array(),
					'ancestor'       => is_array( $type->ancestor ?? null ) ? $type->ancestor : array(),
					'allowed_blocks' => is_array( $type->allowed_blocks ?? null ) ? $type->allowed_blocks : array(),
				);
				$types[ $name ] = array_merge( $registered, $types[ $name ] ?? array() );
			}
		}
		return $types;
	}

	/**
	 * @param array<string, mixed> $block ACF block settings.
	 * @return array<string, mixed>
	 */
	private static function describe_block( string $name, array $block ): array {
		$supports = isset( $block['supports'] ) && is_array( $block['supports'] ) ? $block['supports'] : array();
		$fields   = array();
		foreach ( self::raw_fields( $name ) as $field ) {
			$described = self::describe_field( $field );
			if ( null !== $described ) {
				$fields[] = $described;
			}
		}
		$unsupported = self::unsupported_required_fields( $fields );
		$definition  = array(
			'name'           => $name,
			'title'          => self::text( $block['title'] ?? '' ),
			'mode'           => self::text( $block['mode'] ?? 'preview' ) ?: 'preview',
			// ACF's editor script sets this on every block it mounts, so v2
			// writes it too and the block reopens unchanged.
			'defaultAlign'   => self::text( $block['align'] ?? '' ),
			'innerBlocks'    => ! empty( $supports['jsx'] ),
			'allowedBlocks'  => self::string_list( $block['allowed_blocks'] ?? ( $block['allowedBlocks'] ?? array() ) ),
			'parent'         => self::string_list( $block['parent'] ?? array() ),
			'ancestor'       => self::string_list( $block['ancestor'] ?? array() ),
			'usePostMeta'    => ! empty( $block['use_post_meta'] ) || ! empty( $block['usePostMeta'] ),
			'supports'       => array(
				'align'    => self::align_support( $supports['align'] ?? false ),
				'anchor'   => ! empty( $supports['anchor'] ),
				'multiple' => ! array_key_exists( 'multiple', $supports ) || ! empty( $supports['multiple'] ),
			),
			'fields'         => $fields,
		);
		$description = self::text( $block['description'] ?? '' );
		if ( '' !== $description ) {
			$definition['description'] = $description;
		}
		$definition['schemaHash'] = hash( 'sha256', Runtime_Fingerprint::canonical_json( $definition ) );
		// Post-meta storage is written outside the block and is not supported yet.
		if ( $definition['usePostMeta'] ) {
			$unsupported[] = '(post meta storage)';
		}
		$definition['authorable'] = empty( $unsupported );
		if ( ! empty( $unsupported ) ) {
			$definition['unsupportedFields'] = $unsupported;
		}
		return $definition;
	}

	/** @return array<int, array<string, mixed>> */
	private static function raw_fields( string $name ): array {
		$fields = array();
		$groups = acf_get_field_groups();
		if ( ! is_array( $groups ) ) {
			return array();
		}
		foreach ( $groups as $group ) {
			if ( ! is_array( $group ) || ! self::group_targets_block( $group, $name ) ) {
				continue;
			}
			$group_fields = acf_get_fields( $group );
			if ( is_array( $group_fields ) ) {
				foreach ( $group_fields as $field ) {
					if ( is_array( $field ) ) {
						$fields[] = $field;
					}
				}
			}
		}
		return $fields;
	}

	/** @param array<string, mixed> $group ACF field group. */
	public static function group_targets_block( array $group, string $block_name ): bool {
		$locations = isset( $group['location'] ) && is_array( $group['location'] ) ? $group['location'] : array();
		foreach ( $locations as $rules ) {
			if ( ! is_array( $rules ) ) {
				continue;
			}
			foreach ( $rules as $rule ) {
				if ( ! is_array( $rule ) || ( $rule['param'] ?? null ) !== 'block' ) {
					continue;
				}
				$value = isset( $rule['value'] ) && is_string( $rule['value'] ) ? $rule['value'] : '';
				if ( $value === $block_name || 'all' === $value || $value === 'core/' . $block_name ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * @param array<string, mixed> $field Raw ACF field.
	 * @return array<string, mixed>|null
	 */
	private static function describe_field( array $field ): ?array {
		$type = self::text( $field['type'] ?? '' );
		$name = self::text( $field['name'] ?? '' );
		if ( '' === $type || in_array( $type, self::LAYOUT_TYPES, true ) || ( '' === $name && 'group' !== $type ) ) {
			return null;
		}
		$described = array(
			'key'      => self::text( $field['key'] ?? '' ),
			'name'     => $name,
			'label'    => self::text( $field['label'] ?? '' ),
			'type'     => $type,
			'required' => ! empty( $field['required'] ),
		);
		$instructions = self::text( $field['instructions'] ?? '' );
		if ( '' !== $instructions ) {
			$described['instructions'] = substr( $instructions, 0, 500 );
		}
		if ( array_key_exists( 'default_value', $field ) && null !== $field['default_value'] && '' !== $field['default_value'] && array() !== $field['default_value'] ) {
			$described['default'] = $field['default_value'];
		}
		if ( isset( $field['choices'] ) && is_array( $field['choices'] ) ) {
			$choices = array();
			foreach ( $field['choices'] as $value => $label ) {
				if ( is_scalar( $value ) && is_scalar( $label ) ) {
					$choices[] = array(
						'value' => (string) $value,
						'label' => (string) $label,
					);
				}
			}
			$described['choices'] = $choices;
		}
		if ( in_array( $type, array( 'select', 'post_object', 'page_link', 'user' ), true ) ) {
			$described['multiple'] = ! empty( $field['multiple'] );
		}
		if ( in_array( $type, array( 'checkbox', 'relationship' ), true ) ) {
			$described['multiple'] = true;
		}
		if ( in_array( $type, array( 'select', 'radio', 'button_group', 'post_object', 'page_link' ), true ) ) {
			$described['allowNull'] = ! empty( $field['allow_null'] );
		}
		foreach ( array( 'min', 'max', 'maxlength' ) as $limit ) {
			if ( isset( $field[ $limit ] ) && is_numeric( $field[ $limit ] ) && '' !== $field[ $limit ] ) {
				$described[ $limit ] = 0 + $field[ $limit ];
			}
		}
		if ( isset( $field['post_type'] ) && is_array( $field['post_type'] ) && ! empty( $field['post_type'] ) ) {
			$described['postTypes'] = self::string_list( $field['post_type'] );
		}
		if ( isset( $field['conditional_logic'] ) && is_array( $field['conditional_logic'] ) && ! empty( $field['conditional_logic'] ) ) {
			$described['conditional'] = true;
		}
		if ( in_array( $type, array( 'repeater', 'group' ), true ) ) {
			$described['subFields'] = self::describe_fields( $field['sub_fields'] ?? array() );
		}
		if ( 'flexible_content' === $type ) {
			$layouts = array();
			foreach ( (array) ( $field['layouts'] ?? array() ) as $layout ) {
				if ( ! is_array( $layout ) || '' === self::text( $layout['name'] ?? '' ) ) {
					continue;
				}
				$layouts[] = array(
					'name'      => self::text( $layout['name'] ),
					'label'     => self::text( $layout['label'] ?? '' ),
					'subFields' => self::describe_fields( $layout['sub_fields'] ?? array() ),
				);
			}
			$described['layouts'] = $layouts;
		}
		return $described;
	}

	/**
	 * @param mixed $fields Raw ACF sub fields.
	 * @return array<int, array<string, mixed>>
	 */
	private static function describe_fields( $fields ): array {
		$described = array();
		foreach ( is_array( $fields ) ? $fields : array() as $field ) {
			if ( is_array( $field ) ) {
				$child = self::describe_field( $field );
				if ( null !== $child ) {
					$described[] = $child;
				}
			}
		}
		return $described;
	}

	/**
	 * Required fields v2 cannot fill make the whole block unauthorable.
	 *
	 * @param array<int, array<string, mixed>> $fields Described fields.
	 * @return array<int, string>
	 */
	private static function unsupported_required_fields( array $fields, string $prefix = '' ): array {
		$names = array();
		foreach ( $fields as $field ) {
			$label = $prefix . $field['name'];
			if ( ! in_array( $field['type'], self::VALUE_TYPES, true ) ) {
				if ( ! empty( $field['required'] ) ) {
					$names[] = $label;
				}
				continue;
			}
			foreach ( array_merge( array( $field ), $field['layouts'] ?? array() ) as $container ) {
				if ( isset( $container['subFields'] ) ) {
					$names = array_merge( $names, self::unsupported_required_fields( $container['subFields'], $label . '.' ) );
				}
			}
		}
		return $names;
	}

	// ---------------------------------------------------------------------
	// Fixture records.
	// ---------------------------------------------------------------------

	/** @return array<string, array<string, mixed>> */
	public static function fixture_records(): array {
		$value = function_exists( 'get_option' ) ? get_option( self::FIXTURES_OPTION, array() ) : array();
		return is_array( $value ) ? $value : array();
	}

	/**
	 * `passed` only while the record matches the current schema and ACF
	 * version; a changed field group or ACF update makes it `stale`.
	 *
	 * @return array<string, mixed>
	 */
	public static function fixture_status( string $name ): array {
		$definition = self::definition( $name );
		$record     = self::fixture_records()[ $name ] ?? null;
		if ( null === $definition ) {
			return array( 'status' => 'unregistered' );
		}
		if ( ! $definition['authorable'] ) {
			return array( 'status' => 'unsupported', 'unsupportedFields' => $definition['unsupportedFields'] ?? array() );
		}
		if ( ! is_array( $record ) ) {
			return array( 'status' => 'untested' );
		}
		$status = ( $record['schemaHash'] ?? '' ) === $definition['schemaHash'] && ( $record['acfVersion'] ?? '' ) === self::acf_version()
			? ( 'passed' === ( $record['result'] ?? '' ) ? 'passed' : 'failed' )
			: 'stale';
		return array_merge( $record, array( 'status' => $status ) );
	}

	/**
	 * ACF blocks v2 may author on this site right now.
	 *
	 * @return array<int, string>
	 */
	public static function passing_blocks(): array {
		$names = array();
		foreach ( array_keys( self::definitions() ) as $name ) {
			if ( 'passed' === self::fixture_status( $name )['status'] ) {
				$names[] = $name;
			}
		}
		return $names;
	}

	/**
	 * Definitions plus their fixture status, for discovery and the bridge.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function described_with_status(): array {
		$list = array();
		foreach ( self::definitions() as $name => $definition ) {
			$status = self::fixture_status( $name );
			$definition['fixture'] = array_intersect_key( $status, array_flip( array( 'status', 'testedAt', 'message' ) ) );
			$list[] = $definition;
		}
		return $list;
	}

	/**
	 * Records the outcome of a native save-and-reopen test run in this
	 * site's editor. The server repeats the checks it can make itself:
	 * the schema is current, the markup survives a real save byte-for-byte,
	 * the data matches the field definitions, and the block renders without
	 * PHP errors.
	 *
	 * @param array<string, mixed> $input Fixture result from the editor bridge.
	 * @return array<string, mixed>|\WP_Error
	 */
	public static function record_fixture( array $input ) {
		$name       = self::text( $input['blockName'] ?? '' );
		$definition = self::definition( $name );
		if ( null === $definition ) {
			return self::error( 'unregistered_block', "{$name} is not an ACF block on this site.", 404 );
		}
		if ( ! $definition['authorable'] ) {
			return self::error( 'unsupported_v2_block', "{$name} has required fields v2 cannot fill.", 422 );
		}
		if ( ! hash_equals( $definition['schemaHash'], self::text( $input['schemaHash'] ?? '' ) ) ) {
			return self::error( 'runtime_changed', "The field group for {$name} changed during the test. Run it again.", 409 );
		}
		$saved    = is_string( $input['serializedContent'] ?? null ) ? $input['serializedContent'] : '';
		$reopened = is_string( $input['reopenedContent'] ?? null ) ? $input['reopenedContent'] : '';
		$failure  = self::fixture_failure( $name, $saved, $reopened, $input['editorIssues'] ?? array() );
		$record   = array(
			'result'        => null === $failure ? 'passed' : 'failed',
			'schemaHash'    => $definition['schemaHash'],
			'acfVersion'    => self::acf_version(),
			'pluginVersion' => defined( 'SITEPILOT_VERSION' ) ? (string) SITEPILOT_VERSION : '',
			'testedAt'      => gmdate( 'c' ),
		);
		if ( null !== $failure ) {
			$record['message'] = $failure;
		}
		$records          = self::fixture_records();
		$records[ $name ] = $record;
		update_option( self::FIXTURES_OPTION, $records, false );
		return array_merge( array( 'blockName' => $name ), self::fixture_status( $name ) );
	}

	/** Removes a block's record, so it is kept untouched again. */
	public static function forget_fixture( string $name ): void {
		$records = self::fixture_records();
		unset( $records[ $name ] );
		update_option( self::FIXTURES_OPTION, $records, false );
	}

	/**
	 * @param mixed $editor_issues Issues the bridge reported.
	 */
	private static function fixture_failure( string $name, string $saved, string $reopened, $editor_issues ): ?string {
		if ( is_array( $editor_issues ) && ! empty( $editor_issues ) ) {
			$first = $editor_issues[0];
			return 'The editor reported: ' . substr( is_array( $first ) ? (string) ( $first['message'] ?? 'an issue' ) : (string) $first, 0, 500 );
		}
		if ( '' === trim( $saved ) ) {
			return 'The editor did not produce any markup.';
		}
		if ( $saved !== $reopened ) {
			return 'The block changed when the editor reopened it.';
		}
		$tree = Block_Policy::tokenize( $saved );
		if ( 1 !== count( $tree ) || $name !== $tree[0]['name'] ) {
			return "The test markup is not a single {$name} block.";
		}
		$blocks = parse_blocks( $saved );
		$block  = null;
		foreach ( $blocks as $candidate ) {
			if ( is_array( $candidate ) && $name === ( $candidate['blockName'] ?? null ) ) {
				$block = $candidate;
				break;
			}
		}
		if ( null === $block ) {
			return 'WordPress could not parse the test block.';
		}
		$data  = isset( $block['attrs']['data'] ) && is_array( $block['attrs']['data'] ) ? $block['attrs']['data'] : array();
		$error = self::validate_data( $name, $data );
		if ( null !== $error ) {
			return $error;
		}
		$stored = self::save_and_read_back( $saved );
		if ( is_string( $stored ) && $stored !== $saved ) {
			return 'WordPress changed the block when saving it (for example content filtering removed part of it).';
		}
		if ( $stored instanceof \WP_Error ) {
			return 'WordPress could not save the test post: ' . $stored->get_error_message();
		}
		return self::render_failure( $block );
	}

	/**
	 * Saves the markup into a private scratch draft, reads it back and
	 * deletes the draft.
	 *
	 * @return string|\WP_Error
	 */
	private static function save_and_read_back( string $content ) {
		$post_id = wp_insert_post(
			array(
				'post_type'    => 'page',
				'post_status'  => 'draft',
				'post_title'   => 'SitePilot block test (safe to delete)',
				'post_content' => wp_slash( $content ),
			),
			true
		);
		if ( is_wp_error( $post_id ) ) {
			return $post_id;
		}
		$post_id = (int) $post_id;
		$stored  = (string) get_post_field( 'post_content', $post_id, 'raw' );
		wp_delete_post( $post_id, true );
		return $stored;
	}

	/** @param array<string, mixed> $block Parsed block. */
	private static function render_failure( array $block ): ?string {
		$problems = array();
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_set_error_handler
		set_error_handler(
			static function ( int $severity, string $message ) use ( &$problems ): bool {
				if ( $severity & ( E_DEPRECATED | E_USER_DEPRECATED ) ) {
					return false;
				}
				$problems[] = $message;
				return true;
			}
		);
		try {
			ob_start();
			$html = render_block( $block );
			$echo = (string) ob_get_clean();
		} catch ( \Throwable $error ) {
			if ( ob_get_level() > 0 ) {
				ob_end_clean();
			}
			restore_error_handler();
			return 'The block failed to render: ' . substr( $error->getMessage(), 0, 300 );
		}
		restore_error_handler();
		if ( ! empty( $problems ) ) {
			return 'Rendering the block raised a PHP warning: ' . substr( (string) $problems[0], 0, 300 );
		}
		if ( '' === trim( wp_strip_all_tags( $html . $echo, true ) ) && ! preg_match( '/<[a-z]/i', $html . $echo ) ) {
			return 'The block rendered no output.';
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Block data.
	// ---------------------------------------------------------------------

	/**
	 * Checks ACF block data in its stored shape
	 * (`{name: value, _name: field_key}`, repeater rows as `name_0_sub`).
	 *
	 * @param mixed $data Block data attribute.
	 */
	public static function validate_data( string $name, $data, bool $partial = false ): ?string {
		$definition = self::definition( $name );
		if ( null === $definition ) {
			return "{$name} is not an ACF block on this site.";
		}
		if ( ! is_array( $data ) || ( ! empty( $data ) && array_is_list( $data ) ) ) {
			return "{$name} data must be an object.";
		}
		foreach ( $data as $key => $value ) {
			$key = (string) $key;
			if ( str_starts_with( $key, '_' ) ) {
				$field = self::resolve_field( $definition['fields'], substr( $key, 1 ) );
				if ( null === $field || ! is_string( $value ) || ( '' !== $field['key'] && $value !== $field['key'] ) ) {
					return "{$name} data {$key} does not name the right field key.";
				}
				if ( ! array_key_exists( substr( $key, 1 ), $data ) ) {
					return "{$name} data {$key} has no value.";
				}
				continue;
			}
			$field = self::resolve_field( $definition['fields'], $key );
			if ( null === $field ) {
				return "{$name} has no field called {$key}.";
			}
			if ( ! array_key_exists( '_' . $key, $data ) ) {
				return "{$name} data {$key} is missing its field key (_{$key}).";
			}
			$error = self::value_error( $field, $value );
			if ( null !== $error ) {
				return "{$name} field {$key}: {$error}";
			}
		}
		foreach ( $partial ? array() : $definition['fields'] as $field ) {
			if ( ! empty( $field['required'] ) && empty( $field['conditional'] ) && self::is_empty_value( $data[ $field['name'] ] ?? null ) ) {
				return "{$name} field {$field['name']} is required.";
			}
		}
		return null;
	}

	/**
	 * Finds the field a stored data key refers to, including sub fields of
	 * groups (`group_sub`), repeaters and flexible content (`name_0_sub`).
	 *
	 * @param array<int, array<string, mixed>> $fields Described fields.
	 * @return array<string, mixed>|null
	 */
	private static function resolve_field( array $fields, string $key ): ?array {
		foreach ( $fields as $field ) {
			$field_name = (string) $field['name'];
			if ( $key === $field_name ) {
				return $field;
			}
			if ( '' === $field_name || ! str_starts_with( $key, $field_name . '_' ) ) {
				continue;
			}
			$rest = substr( $key, strlen( $field_name ) + 1 );
			if ( 'group' === $field['type'] ) {
				$found = self::resolve_field( $field['subFields'] ?? array(), $rest );
			} elseif ( in_array( $field['type'], array( 'repeater', 'flexible_content' ), true ) && preg_match( '/^\d+_(.+)$/', $rest, $match ) ) {
				$children = $field['subFields'] ?? array();
				foreach ( $field['layouts'] ?? array() as $layout ) {
					$children = array_merge( $children, $layout['subFields'] );
				}
				$found = self::resolve_field( $children, $match[1] );
			} else {
				$found = null;
			}
			if ( null !== $found ) {
				return $found;
			}
		}
		return null;
	}

	/**
	 * @param array<string, mixed> $field Described field.
	 * @param mixed                $value Stored value.
	 */
	private static function value_error( array $field, $value ): ?string {
		$type = (string) $field['type'];
		if ( ! in_array( $type, self::VALUE_TYPES, true ) ) {
			return "v2 cannot write {$type} fields.";
		}
		if ( self::is_empty_value( $value ) ) {
			return null;
		}
		switch ( $type ) {
			case 'number':
			case 'range':
				if ( ! is_numeric( $value ) ) {
					return 'must be a number.';
				}
				if ( isset( $field['min'] ) && $value < $field['min'] ) {
					return "must be at least {$field['min']}.";
				}
				if ( isset( $field['max'] ) && $value > $field['max'] ) {
					return "must be at most {$field['max']}.";
				}
				return null;
			case 'true_false':
				return in_array( $value, array( 0, 1, '0', '1', true, false ), true ) ? null : 'must be 0 or 1.';
			case 'select':
			case 'radio':
			case 'button_group':
			case 'checkbox':
				$values = is_array( $value ) ? $value : array( $value );
				if ( is_array( $value ) && empty( $field['multiple'] ) ) {
					return 'takes one choice.';
				}
				$allowed = array_column( $field['choices'] ?? array(), 'value' );
				foreach ( $values as $choice ) {
					if ( ! is_scalar( $choice ) || ! in_array( (string) $choice, $allowed, true ) ) {
						return 'is not one of its choices (' . implode( ', ', $allowed ) . ').';
					}
				}
				return null;
			case 'link':
				if ( is_array( $value ) && isset( $value['url'] ) && is_string( $value['url'] ) && self::safe_url( $value['url'] ) ) {
					return null;
				}
				return 'must be a link with a safe url.';
			case 'url':
			case 'oembed':
				return is_string( $value ) && self::safe_url( $value ) ? null : 'must be a safe URL.';
			case 'email':
				return is_string( $value ) && false !== filter_var( $value, FILTER_VALIDATE_EMAIL ) ? null : 'must be an email address.';
			case 'image':
			case 'file':
				return self::positive_id( $value ) && self::attachment_exists( (int) $value ) ? null : 'must be an existing media library ID.';
			case 'post_object':
			case 'page_link':
			case 'relationship':
				foreach ( is_array( $value ) ? $value : array( $value ) as $id ) {
					if ( ! self::positive_id( $id ) ) {
						return 'must be post IDs.';
					}
				}
				return null;
			case 'repeater':
				return is_numeric( $value ) && (int) $value >= 0 ? null : 'must be the row count.';
			case 'flexible_content':
				return is_array( $value ) && array_is_list( $value ) ? null : 'must list its layouts.';
			case 'group':
				return null;
			default:
				return is_string( $value ) || is_numeric( $value ) ? null : 'must be text.';
		}
	}

	/** @param mixed $value Stored value. */
	private static function is_empty_value( $value ): bool {
		return null === $value || '' === $value || array() === $value;
	}

	/** @param mixed $value Candidate ID. */
	private static function positive_id( $value ): bool {
		return ( is_int( $value ) && $value > 0 ) || ( is_string( $value ) && ctype_digit( $value ) && (int) $value > 0 );
	}

	private static function attachment_exists( int $id ): bool {
		if ( ! function_exists( 'get_post_type' ) ) {
			return true;
		}
		return 'attachment' === get_post_type( $id );
	}

	private static function safe_url( string $url ): bool {
		$url = trim( $url );
		if ( '' === $url || preg_match( '/^\s*(javascript|data|vbscript):/i', $url ) ) {
			return false;
		}
		return (bool) preg_match( '#^(https?://|/|\#|\?)#i', $url );
	}

	/**
	 * Fills an ACF block's data from its field definitions: values given by
	 * field name, key or label are stored under the field name, choice
	 * labels become choice values, and fields left out take their defaults.
	 *
	 * @param array<string, mixed> $data  Requested data.
	 * @param array<string, mixed> $extra Loose top-level attributes that may name fields.
	 * @return array<string, mixed>
	 */
	public static function normalize_data( string $name, array $data, array $extra = array() ): array {
		$definition = self::definition( $name );
		if ( null === $definition ) {
			return $data;
		}
		$normalized = array();
		foreach ( $definition['fields'] as $field ) {
			if ( '' === $field['name'] || ! in_array( $field['type'], self::VALUE_TYPES, true ) ) {
				continue;
			}
			$aliases = array_filter( array( $field['name'], $field['key'], $field['label'] ) );
			$value   = null;
			foreach ( array( $extra, $data ) as $source ) {
				foreach ( $source as $key => $candidate ) {
					if ( self::matches_alias( (string) $key, $aliases ) && ! self::is_empty_value( $candidate ) ) {
						$resolved = is_string( $candidate ) ? self::choice_value( $field, $candidate ) : null;
						// A loose attribute only counts when it names a real choice.
						if ( $source === $extra && null === $resolved && ! empty( $field['choices'] ) ) {
							continue;
						}
						$value = $resolved ?? $candidate;
						break 2;
					}
				}
			}
			if ( null === $value && array_key_exists( 'default', $field ) ) {
				$value = is_string( $field['default'] ) ? ( self::choice_value( $field, $field['default'] ) ?? $field['default'] ) : $field['default'];
			}
			if ( null === $value ) {
				continue;
			}
			if ( 'true_false' === $field['type'] ) {
				$value = in_array( $value, array( 1, '1', true, 'true', 'yes' ), true ) ? '1' : '0';
			}
			$normalized[ $field['name'] ]       = $value;
			$normalized[ '_' . $field['name'] ] = $field['key'];
		}
		// Anything else already in stored shape (such as repeater rows) is kept.
		foreach ( $data as $key => $value ) {
			$key = (string) $key;
			if ( ! array_key_exists( $key, $normalized ) && null !== self::resolve_field( $definition['fields'], ltrim( $key, '_' ) ) && ! self::is_top_level_alias( $definition['fields'], $key ) ) {
				$normalized[ $key ] = $value;
			}
		}
		return $normalized;
	}

	/** @param array<int, array<string, mixed>> $fields Described fields. */
	private static function is_top_level_alias( array $fields, string $key ): bool {
		foreach ( $fields as $field ) {
			if ( $key !== $field['name'] && '_' . $field['name'] !== $key && self::matches_alias( $key, array_filter( array( $field['key'], $field['label'] ) ) ) ) {
				return true;
			}
		}
		return false;
	}

	/** @param array<int, string> $aliases Field name, key and label. */
	private static function matches_alias( string $key, array $aliases ): bool {
		$token = self::normalize_choice_token( $key );
		foreach ( $aliases as $alias ) {
			$alias_token = self::normalize_choice_token( (string) $alias );
			// British and American spellings of colour are the same field.
			if ( $token === $alias_token || str_replace( 'colour', 'color', $token ) === str_replace( 'colour', 'color', $alias_token ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The stored value for a requested choice, matching either the choice
	 * value or its label.
	 *
	 * @param array<string, mixed> $field Described field.
	 */
	public static function choice_value( array $field, string $requested ): ?string {
		if ( empty( $field['choices'] ) || ! is_array( $field['choices'] ) ) {
			return null;
		}
		$wanted = self::normalize_choice_token( $requested );
		foreach ( $field['choices'] as $choice ) {
			if ( self::normalize_choice_token( (string) $choice['value'] ) === $wanted || self::normalize_choice_token( (string) $choice['label'] ) === $wanted ) {
				return (string) $choice['value'];
			}
		}
		return null;
	}

	public static function normalize_choice_token( string $value ): string {
		$normalized = strtolower( trim( $value ) );
		$normalized = preg_replace( '/[\s_-]+/', ' ', $normalized );
		return is_string( $normalized ) ? $normalized : strtolower( trim( $value ) );
	}

	// ---------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------

	/** @param mixed $value Raw align support. @return bool|array<int, string> */
	private static function align_support( $value ) {
		if ( is_array( $value ) ) {
			return self::string_list( $value );
		}
		return (bool) $value;
	}

	/** @param mixed $value Raw value. */
	private static function text( $value ): string {
		return is_string( $value ) ? trim( $value ) : ( is_scalar( $value ) ? trim( (string) $value ) : '' );
	}

	/** @param mixed $value Raw list. @return array<int, string> */
	private static function string_list( $value ): array {
		return is_array( $value ) ? array_values( array_filter( array_map( array( self::class, 'text' ), $value ) ) ) : array();
	}

	private static function error( string $code, string $message, int $status ): \WP_Error {
		return new \WP_Error( 'sitepilot_v2_' . $code, $message, array( 'status' => $status, 'code' => $code ) );
	}
}
